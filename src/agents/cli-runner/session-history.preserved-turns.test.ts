import path from "node:path";
import { expect, it } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
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

it("preserves unseen Claude exchanges and bounds", async ({ onTestFinished }) => {
  const tempDirs = createTempDirTracker();
  const dir = tempDirs.make("openclaw-cli-preserved-");
  const admission = prepareSystemAgentRunAdmission({}, "preserved", "main", "history-test");
  onTestFinished(async () => {
    admission.close();
    await cleanupSessionStateForTest({ stateDir: dir });
    tempDirs.cleanup();
  });
  const target = {
    agentId: "main",
    sessionId: "history-session",
    sessionKey: "agent:main:history",
    storePath: path.join(dir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  const admittedRunContext = await admission.admit("embedded");
  const append = (tick: number, message: unknown) =>
    appendTranscriptMessage(target, { eventId: `message-${tick}`, now: tick * 1000, message });
  const reply = (index: number, runId = `run-${index}`, text = `reply-${index}`) =>
    append(index * 2 + 2, {
      ...buildAssistantMessage({
        model: { api: "cli", provider: "claude-cli", id: "test-model" },
        content: [{ type: "text", text }],
        stopReason: "stop",
        usage: buildUsageWithNoCost({}),
      }),
      __openclaw: { runId },
    });
  const turn = async (index: number, text: string, provenance?: InputProvenance) => {
    await append(index * 2 + 1, {
      ...makeUserMessage(text, index * 2000 + 1000),
      ...(provenance && { provenance }),
    });
    await reply(index);
  };
  const completion = { kind: "inter_session", sourceTool: "subagent_announce" } as const;
  const resumed = {
    sessionTarget: target,
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
    admittedRunContext,
    nativeSessionId: "native-session",
    provider: "claude-cli",
  };
  const load = (overrides: Partial<Parameters<typeof loadCliSessionPromptContext>[0]> = {}) =>
    loadCliSessionPromptContext({ ...resumed, ...overrides });
  const preserved = async (overrides: Parameters<typeof load>[0] = {}) =>
    (await load(overrides)).preservedTurnsContext;
  await turn(0, "Spawn the review.");
  await turn(1, "Child result: CHILD_RESULT_7f3a9c", completion);
  await turn(2, "Refresh the card.", {
    kind: "internal_system",
    sourceTool: PROGRESS_CARD_REFRESH_SOURCE_TOOL,
  });
  // A direct completion saves only its reply, under the announce run id.
  await reply(3, "announce:v1:agent:main:subagent:child:run-2");

  const context = await load();
  const prompt = annotateInterSessionPromptText("Child result: CHILD_RESULT_7f3a9c", completion);
  const exchanges = [
    { source: "subagent_announce", prompt, reply: "reply-1" },
    { source: "subagent_announce", reply: "reply-3" },
  ];
  expect(context.preservedTurnsContext).toContain(JSON.stringify(exchanges));
  expect(context.preservedTurnsContext).toContain("Verify current and time-sensitive facts");
  expect(context.sessionGapContext).toBeUndefined();
  expect(await preserved({ nativeSessionId: undefined })).toBeUndefined();

  const withheld = await load({ rawTranscriptReseedReason: "auth-unknown" });
  expect(withheld.preservedTurnsContext).toBeUndefined();
  expect(withheld.sessionGapContext).toBe(
    '[OpenClaw: 5 messages recorded in this chat since your last reply here (possibly already in this session) from 1970-01-01T00:00:03.000Z to 1970-01-01T00:00:08.000Z, using "claude-cli/test-model". Their contents are not included here.]',
  );

  await turn(4, "What did the review find?");
  expect(await preserved()).toBeUndefined();

  // The newest eight are carried; older ones stay in saved history.
  for (let index = 5; index < 14; index++) {
    await reply(index, `announce:v1:agent:main:subagent:child:run-${index}`);
  }
  await reply(14, "announce:long", "```" + "x".repeat(3_000));
  const newest = await preserved();
  expect(newest).not.toContain('"reply":"reply-6"');
  for (let index = 7; index < 14; index++) {
    expect(newest).toContain(`"reply":"reply-${index}"`);
  }
  expect(newest).toContain("`\u200b``");
  expect(newest).toContain("…[truncated]");
  expect(newest).not.toContain("x".repeat(2_000));
});
