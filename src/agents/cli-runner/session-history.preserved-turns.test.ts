import { expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";
import {
  annotateInterSessionPromptText,
  PROGRESS_CARD_REFRESH_SOURCE_TOOL,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../stream-message-shared.js";
import { createHistoryBoundaryFixture } from "./history-boundary.test-support.js";
import { loadCliSessionPromptContext } from "./session-history.js";

it("preserves unseen Claude exchanges and bounds", async ({ onTestFinished }) => {
  const dirs = useSessionStoreTempDirs(onTestFinished, "openclaw-cli-preserved-");
  onTestFinished(clearRuntimeConfigSnapshot);
  const { target, withRun } = await createHistoryBoundaryFixture(dirs, false);
  await withRun("preserved", async (params) => {
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
    const load = (overrides: Partial<Parameters<typeof loadCliSessionPromptContext>[0]> = {}) =>
      loadCliSessionPromptContext({
        ...params,
        nativeSessionId: "native-session",
        provider: "claude-cli",
        ...overrides,
      });
    const preserved = async (overrides: Parameters<typeof load>[0] = {}) =>
      (await load(overrides)).resumeContext;
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
      { role: "user", content: prompt },
      { role: "assistant", content: "reply-1" },
      { role: "assistant", content: "reply-3" },
    ];
    expect(context.resumeContext).toContain(JSON.stringify(exchanges));
    expect(context.sessionGapContext).toBeUndefined();
    expect(await preserved({ nativeSessionId: undefined })).toBeUndefined();

    await turn(4, "What did the review find?");
    expect(await preserved()).toBeUndefined();

    // The newest eight are carried; older ones stay in saved history.
    for (let index = 5; index < 14; index++) {
      await reply(index, `announce:v1:agent:main:subagent:child:run-${index}`);
    }
    await reply(14, "announce:long", "```" + "x".repeat(3_000));
    const newest = await preserved();
    expect(newest).not.toContain('"content":"reply-6"');
    for (let index = 7; index < 14; index++) {
      expect(newest).toContain(`"content":"reply-${index}"`);
    }
    expect(newest).toContain("`\u200b``");
    expect(newest).toContain("…[truncated]");
    expect(newest).not.toContain("x".repeat(2_000));
  });
});
