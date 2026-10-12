import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  annotateInterSessionPromptText,
  PROGRESS_CARD_REFRESH_SOURCE_TOOL,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../stream-message-shared.js";
import { loadCliSessionPromptContext } from "./session-history.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
  });
});

async function createSession() {
  const dir = tempDirs.make("openclaw-cli-preserved-");
  const target = {
    agentId: "main",
    sessionId: "history-session",
    sessionKey: "agent:main:history",
    storePath: path.join(dir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  return { target, params: { sessionTarget: target } };
}

describe("preserved Claude turns", () => {
  it("carries completion exchanges since the last ordinary reply, or counts them when content is withheld", async () => {
    const { target, params } = await createSession();
    const admission = prepareSystemAgentRunAdmission({}, "preserved", "main", "history-test");
    const admittedRunContext = await admission.admit("embedded");
    const reply = async (index: number, runId = `run-${index}`) =>
      await appendTranscriptMessage(target, {
        eventId: `assistant-${index}`,
        now: index * 2000 + 2000,
        message: {
          ...buildAssistantMessage({
            model: { api: "cli", provider: "claude-cli", id: "test-model" },
            content: [{ type: "text", text: `reply-${index}` }],
            stopReason: "stop",
            usage: buildUsageWithNoCost({}),
          }),
          __openclaw: { runId },
        },
      });
    const turn = async (index: number, text: string, provenance?: InputProvenance) => {
      await appendTranscriptMessage(target, {
        eventId: `user-${index}`,
        now: index * 2000 + 1000,
        message: {
          ...makeUserMessage(text, index * 2000 + 1000),
          ...(provenance && { provenance }),
        },
      });
      await reply(index);
    };
    const completion = { kind: "inter_session", sourceTool: "subagent_announce" } as const;
    try {
      const resumed = {
        ...params,
        sessionKey: target.sessionKey,
        sessionId: target.sessionId,
        admittedRunContext,
        nativeSessionId: "native-session",
        provider: "claude-cli",
        tools: [],
      };
      await turn(0, "Spawn the review.");
      await turn(1, "Child result: CHILD_RESULT_7f3a9c", completion);
      await turn(2, "Refresh the card.", {
        kind: "internal_system",
        sourceTool: PROGRESS_CARD_REFRESH_SOURCE_TOOL,
      });
      // A direct completion saves only its reply, under the announce run id.
      await reply(3, "announce:v1:agent:main:subagent:child:run-2");

      const context = await loadCliSessionPromptContext(resumed);
      expect(context.unseenTurns).toEqual([
        {
          prompt: annotateInterSessionPromptText("Child result: CHILD_RESULT_7f3a9c", completion),
          reply: "reply-1",
        },
        { reply: "reply-3" },
      ]);
      expect(context.sessionGapContext).toBeUndefined();
      expect(
        (await loadCliSessionPromptContext({ ...resumed, nativeSessionId: undefined })).unseenTurns,
      ).toBeUndefined();

      const withheld = await loadCliSessionPromptContext({
        ...resumed,
        rawTranscriptReseedReason: "auth-unknown",
      });
      expect(withheld.unseenTurns).toBeUndefined();
      expect(withheld.sessionGapContext).toBe(
        '[OpenClaw: 5 messages occurred outside this Claude session from 1970-01-01T00:00:03.000Z to 1970-01-01T00:00:08.000Z, using "claude-cli/test-model". Their contents are not included here.]',
      );

      // The next ordinary reply means the bound session has now seen them.
      await turn(4, "What did the review find?");
      expect((await loadCliSessionPromptContext(resumed)).unseenTurns).toBeUndefined();
    } finally {
      admission.close();
    }
  });
});
