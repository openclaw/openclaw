import { describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { AGENT_LANE_SUBAGENT } from "../../lanes.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput } from "./terminal-resolution.test-support.js";
import { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";

describe("terminal resolution, subagent reasoning-only retry", () => {
  it("retries a reasoning-only terminal turn in the subagent lane instead of settling it as silence", async () => {
    // Regression: run ad43ead1-b244-4683-8da9-47cbdaa5e5fa (2026-09-21, session
    // agent:main:subagent:bf740eaf) ended a subagent lane with 12,364 reasoning
    // tokens, zero visible text, stopReason=stop. The lane's silent contract
    // (allowEmptyAssistantReplyAsSilent + terminalReplyExpectation=optional)
    // classified the turn as tolerated silence and skipped the bounded
    // reasoning-only retry, so the run died with terminalError=
    // non_deliverable_terminal_turn after 13 min of a 2h budget.
    const assistant = buildEmbeddedRunnerAssistant({
      content: [
        {
          type: "thinking",
          thinking: "working through the diff",
          thinkingSignature: JSON.stringify({ id: "rs_subagent", type: "reasoning" }),
        },
      ],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const activateInternalPrompt = vi.fn();
    const retryInput = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      runParams: {
        lane: AGENT_LANE_SUBAGENT,
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
      },
      activateInternalPrompt,
    });

    await expect(resolveEmbeddedRunTerminal(retryInput)).resolves.toEqual({ action: "retry" });
    expect(retryInput.retryState.reasoningOnlyAttempts).toBe(1);
    expect(activateInternalPrompt).toHaveBeenCalledWith(REASONING_ONLY_RETRY_INSTRUCTION);

    // After the bounded retry budget is spent, the turn surfaces the
    // incomplete-turn error instead of settling silently, and a retained
    // replay-safe tool presentation rides along with the error payload even
    // though the lane's silent contract suppresses the ordinary
    // incomplete-turn text.
    const exhaustedInput = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      retryState: { ...createEmbeddedRunTerminalRetryState(), reasoningOnlyAttempts: 2 },
      readTerminalToolPresentation: () =>
        "Web fetch completed.\nOrigin: https://example.com\nStatus: 200",
      runParams: {
        lane: AGENT_LANE_SUBAGENT,
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
      },
    });
    const exhausted = await resolveEmbeddedRunTerminal(exhaustedInput);

    expect(exhausted.action).toBe("complete");
    if (exhausted.action !== "complete") {
      return;
    }
    expect(exhausted.result.meta.error).toMatchObject({
      kind: "incomplete_turn",
      fallbackSafe: true,
      terminalPresentation: true,
    });
    expect(exhausted.result.payloads).toEqual([
      {
        text:
          "Web fetch completed.\nOrigin: https://example.com\nStatus: 200\n\n" +
          "⚠️ Agent couldn't generate a response. Please try again.",
        isError: true,
      },
    ]);
  });

  it("keeps an explicit NO_REPLY subagent turn silent without retrying", async () => {
    // The silent contract exists for authored silence; the reasoning-only
    // retry must not re-open it. NO_REPLY carries visible assistant text, so
    // resolveReasoningOnlyRetryInstruction rejects it and the turn completes
    // silently exactly as before.
    const assistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: SILENT_REPLY_TOKEN }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [SILENT_REPLY_TOKEN],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    });
    const activateInternalPrompt = vi.fn();
    const input = makeTerminalInput({
      attempt,
      attemptAssistant: assistant,
      finalAssistantRawText: SILENT_REPLY_TOKEN,
      runParams: {
        lane: AGENT_LANE_SUBAGENT,
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
      },
      activateInternalPrompt,
    });

    const resolved = await resolveEmbeddedRunTerminal(input);

    expect(resolved.action).toBe("complete");
    if (resolved.action !== "complete") {
      return;
    }
    expect(resolved.result.meta.error).toBeUndefined();
    expect(resolved.result.meta.terminalReplyKind).toBe("silent-empty");
    expect(activateInternalPrompt).not.toHaveBeenCalled();
  });
});
