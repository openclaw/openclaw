import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import {
  readSessionTranscriptVisibleMessageDelta,
  type SessionTranscriptTargetParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterAll, describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import * as transcriptAnchors from "../../config/sessions/session-transcript-anchor-read.js";
import type { ContextEngineSessionTarget } from "../../context-engine/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  bootstrapHarnessContextEngine,
  finalizeHarnessContextEngineTurn,
} from "./context-engine-lifecycle.js";
import { createContextEngine as createEngine } from "./context-engine-lifecycle.test-support.js";
import { appendTurnMessage } from "./context-engine-turn.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-context-terminal-");

function requireTranscriptTarget(params: {
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: ContextEngineSessionTarget;
}): SessionTranscriptTargetParams {
  const sessionId = params.sessionTarget?.sessionId ?? params.sessionId;
  const sessionKey = params.sessionTarget?.sessionKey ?? params.sessionKey;
  if (!sessionKey) {
    throw new Error("context engine transcript reads require a session key");
  }
  return { ...params.sessionTarget, sessionId, sessionKey };
}

function readMessageContent(message: AgentMessage): unknown {
  return "content" in message ? message.content : undefined;
}

type FinalizeParams = Parameters<typeof finalizeHarnessContextEngineTurn>[0];
function finalize(
  params: Pick<FinalizeParams, "sessionFile" | "sessionIdUsed"> & Partial<FinalizeParams>,
) {
  return finalizeHarnessContextEngineTurn({
    messagesSnapshot: [],
    prePromptMessageCount: 0,
    promptError: false,
    aborted: false,
    yieldAborted: false,
    warn: vi.fn(),
    ...params,
  });
}

describe("context engine transcript cursor contract", () => {
  it("records a reconstructed terminal anchor despite an intervening transcript append", async () => {
    const target = {
      agentId: "main",
      sessionId: "terminal-append",
      sessionKey: "agent:main:terminal-append",
      storePath: path.join(sessionDirs.make(), "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const user = await appendTurnMessage(target, "user", "request", 1_000);
    const terminal = await appendTurnMessage(target, "assistant", "reply", 2_000, user!.messageId);
    const readAnchor = transcriptAnchors.readActiveTranscriptEntryAnchorAsync;
    const read = vi
      .spyOn(transcriptAnchors, "readActiveTranscriptEntryAnchorAsync")
      .mockImplementation(async (...args) => {
        const anchor = await readAnchor(...args);
        // Append after the snapshot is read, before finalization consumes its terminal anchor.
        await appendTurnMessage(target, "assistant", "later reply", 3_000);
        return anchor;
      });
    const record = vi.fn();
    try {
      await finalize({
        contextEngine: createEngine(),
        sessionIdUsed: target.sessionId,
        sessionKey: target.sessionKey,
        sessionFile: target.storePath,
        turnCandidate: {
          admission: { ...user!.anchor!, logicalTurnId: "turn", role: "user" },
          terminalEntryId: terminal!.messageId,
          record,
        },
      });
      expect(read).toHaveBeenCalledOnce();
      expect(record).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          boundary: expect.objectContaining({ terminal: terminal!.anchor }),
        }),
      );
    } finally {
      read.mockRestore();
    }
  });

  it("bootstraps, resumes appends, and rebuilds after replacement through the public SDK", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const target = {
      agentId: "main",
      sessionId: "context-engine-cursor",
      sessionKey: "agent:main:context-engine-cursor",
      sessionEntry: { sessionId: "context-engine-cursor", updatedAt: 10 },
      storePath,
    };
    const projectedMessages: AgentMessage[] = [];
    let cursor: string | undefined;
    let resetCount = 0;

    const consumeVisibleTranscript = async (params: {
      sessionId: string;
      sessionKey?: string;
      sessionTarget?: ContextEngineSessionTarget;
    }) => {
      const readTarget = requireTranscriptTarget(params);
      for (;;) {
        const result = await readSessionTranscriptVisibleMessageDelta({
          ...readTarget,
          ...(cursor ? { cursor } : {}),
          maxBytes: 10_000,
          maxMessages: 1,
        });
        if (result.kind === "missing" || result.kind === "unavailable") {
          return;
        }
        if (result.kind === "reset") {
          projectedMessages.length = 0;
          cursor = result.cursor;
          resetCount += 1;
          continue;
        }
        projectedMessages.push(...result.entries.map((entry) => entry.message));
        cursor = result.cursor;
        if (!result.hasMore) {
          return;
        }
      }
    };
    const engine = createEngine({
      info: {
        id: "cursor-proof",
        name: "Cursor proof",
        transcriptSemantics: { currentTurnFence: "before-current-turn-entry-v1" },
      },
      bootstrap: async (params) => {
        await consumeVisibleTranscript(params);
        return { bootstrapped: true, importedMessages: projectedMessages.length };
      },
      afterTurn: consumeVisibleTranscript,
    });
    const skipMaintenance: NonNullable<
      Parameters<typeof bootstrapHarnessContextEngine>[0]["runMaintenance"]
    > = async () => undefined;
    const lifecycle = {
      contextEngine: engine,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      sessionFile: "sqlite://context-engine-cursor",
      runMaintenance: skipMaintenance,
      warn: () => {},
    };
    const finish = (promptError = false) =>
      finalize({
        ...lifecycle,
        promptError,
        sessionIdUsed: target.sessionId,
      });

    try {
      setRuntimeConfigSnapshot({ session: { store: storePath } });
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 10 });
      const first = await appendTurnMessage(target, "user", "first", 1_000);
      await appendTurnMessage(target, "assistant", "second", 2_000, first?.messageId);
      const admitted = await createUserTurnTranscriptRecorder({
        message: { role: "user", content: "third", timestamp: 3_000 },
        target,
        updateMode: "none",
      }).persistApproved();
      if (!admitted) {
        throw new Error("expected admitted user message with transcript admission");
      }
      const admission = admitted.admission;

      await bootstrapHarnessContextEngine({
        ...lifecycle,
        hadSessionFile: true,
        sessionId: target.sessionId,
        transcriptReadFence: admission,
      });
      expect(projectedMessages.map(readMessageContent)).toEqual(["first", "second"]);

      await appendTurnMessage(target, "assistant", "fourth", 4_000, admitted.messageId);
      await finish();
      const history = ["first", "second", "third", "fourth"];
      expect(projectedMessages.map(readMessageContent)).toEqual(history);

      await appendTurnMessage(target, "user", "failed turn", 5_000);
      await finish(true);
      expect(projectedMessages.map(readMessageContent)).toEqual(history);

      await replaceTranscriptEvents(target, [
        {
          type: "message",
          id: "replacement",
          parentId: null,
          timestamp: "1970-01-01T00:00:06.000Z",
          message: { role: "user", content: "replacement" },
        },
      ]);
      await finish();
      expect(resetCount).toBe(1);
      expect(projectedMessages.map(readMessageContent)).toEqual(["replacement"]);
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });
});
