import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import {
  readSessionTranscriptVisibleMessageDelta,
  type SessionTranscriptTargetParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import * as transcriptHydration from "../../config/sessions/session-transcript-hydration.js";
import type { ContextEngine, ContextEngineSessionTarget } from "../../context-engine/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  cleanupSessionStateForTest,
  useSessionStoreTempDirs,
} from "../../test-utils/session-state-cleanup.js";
import {
  bootstrapHarnessContextEngine,
  finalizeHarnessContextEngineTurn,
} from "./context-engine-lifecycle.js";

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
  return {
    sessionId,
    sessionKey,
    ...(params.sessionTarget?.agentId ? { agentId: params.sessionTarget.agentId } : {}),
    ...(params.sessionTarget?.storePath ? { storePath: params.sessionTarget.storePath } : {}),
    ...(params.sessionTarget?.threadId !== undefined
      ? { threadId: params.sessionTarget.threadId }
      : {}),
  };
}

function readMessageContent(message: AgentMessage): unknown {
  return "content" in message ? message.content : undefined;
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
    const user = await appendTranscriptMessage(target, {
      message: { role: "user", content: "request" },
      now: 1_000,
    });
    const terminal = await appendTranscriptMessage(target, {
      message: { role: "assistant", content: "reply" },
      parentId: user!.messageId,
      now: 2_000,
    });
    const prepare = transcriptHydration.prepareSessionTranscriptHydration;
    const read = vi
      .spyOn(transcriptHydration, "prepareSessionTranscriptHydration")
      .mockImplementation((...args) => {
        const reader = prepare(...args);
        return {
          ...reader,
          readMaintenance: async (request) => {
            const result = await reader.readMaintenance(request);
            // Expose the split-read race using a real write, not a stale mock version.
            await appendTranscriptMessage(target, {
              message: { role: "assistant", content: "later reply" },
              now: 3_000,
            });
            return result;
          },
        };
      });
    const record = vi.fn();
    const engine: ContextEngine = {
      info: { id: "terminal-proof", name: "Terminal proof" },
      ingest: async () => ({ ingested: true }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
    };
    try {
      await finalizeHarnessContextEngineTurn({
        contextEngine: engine,
        sessionIdUsed: target.sessionId,
        sessionKey: target.sessionKey,
        sessionFile: target.storePath,
        messagesSnapshot: [],
        prePromptMessageCount: 0,
        promptError: false,
        aborted: false,
        yieldAborted: false,
        turnCandidate: {
          admission: { ...user!.anchor!, logicalTurnId: "turn", role: "user" },
          terminalEntryId: terminal!.messageId,
          record,
        },
        warn: vi.fn(),
      });
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-context-engine-cursor-"));
    const storePath = path.join(tempDir, "sessions.json");
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
    const engine: ContextEngine = {
      info: {
        id: "cursor-proof",
        name: "Cursor proof",
        transcriptSemantics: { currentTurnFence: "before-current-turn-entry-v1" },
      },
      bootstrap: async (params) => {
        await consumeVisibleTranscript(params);
        return { bootstrapped: true, importedMessages: projectedMessages.length };
      },
      ingest: async () => ({ ingested: true }),
      assemble: async (params) => ({ messages: params.messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: true, compacted: false }),
      afterTurn: consumeVisibleTranscript,
    };
    const skipMaintenance: NonNullable<
      Parameters<typeof bootstrapHarnessContextEngine>[0]["runMaintenance"]
    > = async () => undefined;

    try {
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 10 });
      const first = await appendTranscriptMessage(target, {
        message: { role: "user", content: "first" },
        now: 1_000,
      });
      await appendTranscriptMessage(target, {
        message: { role: "assistant", content: "second" },
        parentId: first?.messageId,
        now: 2_000,
      });
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
        hadSessionFile: true,
        contextEngine: engine,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        sessionFile: "sqlite://context-engine-cursor",
        transcriptReadFence: admission,
        runMaintenance: skipMaintenance,
        warn: () => {},
      });
      expect(projectedMessages.map(readMessageContent)).toEqual(["first", "second"]);

      await appendTranscriptMessage(target, {
        message: { role: "assistant", content: "fourth" },
        parentId: admitted.messageId,
        now: 4_000,
      });
      await finalizeHarnessContextEngineTurn({
        contextEngine: engine,
        promptError: false,
        aborted: false,
        yieldAborted: false,
        sessionIdUsed: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        sessionFile: "sqlite://context-engine-cursor",
        messagesSnapshot: [],
        prePromptMessageCount: 0,
        runMaintenance: skipMaintenance,
        warn: () => {},
      });
      expect(projectedMessages.map(readMessageContent)).toEqual([
        "first",
        "second",
        "third",
        "fourth",
      ]);

      await appendTranscriptMessage(target, {
        message: { role: "user", content: "failed turn" },
        now: 5_000,
      });
      await finalizeHarnessContextEngineTurn({
        contextEngine: engine,
        promptError: true,
        aborted: false,
        yieldAborted: false,
        sessionIdUsed: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        sessionFile: "sqlite://context-engine-cursor",
        messagesSnapshot: [],
        prePromptMessageCount: 0,
        runMaintenance: skipMaintenance,
        warn: () => {},
      });
      expect(projectedMessages.map(readMessageContent)).toEqual([
        "first",
        "second",
        "third",
        "fourth",
      ]);

      await replaceTranscriptEvents(target, [
        {
          type: "message",
          id: "replacement",
          parentId: null,
          timestamp: "1970-01-01T00:00:06.000Z",
          message: { role: "user", content: "replacement" },
        },
      ]);
      await finalizeHarnessContextEngineTurn({
        contextEngine: engine,
        promptError: false,
        aborted: false,
        yieldAborted: false,
        sessionIdUsed: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        sessionFile: "sqlite://context-engine-cursor",
        messagesSnapshot: [],
        prePromptMessageCount: 0,
        runMaintenance: skipMaintenance,
        warn: () => {},
      });
      expect(resetCount).toBe(1);
      expect(projectedMessages.map(readMessageContent)).toEqual(["replacement"]);
    } finally {
      await cleanupSessionStateForTest({ stateDir: tempDir });
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
