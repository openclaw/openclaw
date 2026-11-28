import { expect, it } from "vitest";
import { createEmbeddedRunReplayState } from "./replay-state.js";
import { isEmbeddedRunReplaySafe } from "./transcript-conflict.js";

const safe = { replayMetadata: { replaySafe: true, hadPotentialSideEffects: false } };
it("requires positive whole-run replay evidence and refuses already started effects", () => {
  const previous = createEmbeddedRunReplayState();
  expect(isEmbeddedRunReplaySafe(previous, safe)).toBe(true);
  for (const attempt of [
    {},
    { replayMetadata: { replaySafe: false, hadPotentialSideEffects: false } },
    { replayMetadata: { replaySafe: true, hadPotentialSideEffects: true } },
    { ...safe, didSendDeterministicApprovalPrompt: true },
    {
      ...safe,
      clientToolCalls: [{ name: "external-effect", params: {} }],
    },
    { ...safe, didSendViaMessagingTool: true },
    { ...safe, messagingToolSentTexts: ["Already sent"] },
    {
      ...safe,
      acceptedSessionSpawns: [
        { runId: "started-child", childSessionKey: "agent:main:subagent:started-child" },
      ],
    },
  ]) {
    expect(isEmbeddedRunReplaySafe(previous, attempt)).toBe(false);
  }
  expect(isEmbeddedRunReplaySafe(createEmbeddedRunReplayState({ replayInvalid: true }), safe)).toBe(
    false,
  );
  expect(
    isEmbeddedRunReplaySafe(createEmbeddedRunReplayState({ hadPotentialSideEffects: true }), safe),
  ).toBe(false);
});
