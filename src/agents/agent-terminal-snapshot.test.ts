import { describe, expect, it } from "vitest";
import {
  withAgentTerminalPayloadSnapshot,
  readAgentTerminalPayloadSnapshot,
  readAgentTerminalSnapshot,
  withAgentTerminalSnapshot,
} from "./agent-terminal-snapshot.js";
import { captureAgentTerminalSnapshot } from "./embedded-agent-runner/run/attempt-terminal-snapshot.js";
import { coerceToFailoverError } from "./failover-error.js";
import { throwFallbackFailureSummary } from "./model-fallback-attempt.js";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
} from "./test-helpers/agent-message-fixtures.js";

const snapshot = captureAgentTerminalSnapshot({
  terminalMessage: undefined,
  reachedPromptBoundary: true,
  success: false,
  hasHookError: true,
});

describe("selected agent terminal error observations", () => {
  it("observes string-content terminal messages without disrupting the attempt", () => {
    const terminalMessage = castAgentMessage({
      role: "assistant",
      content: "Synthetic terminal text",
      stopReason: "stop",
    });
    expect(
      captureAgentTerminalSnapshot({
        terminalMessage,
        reachedPromptBoundary: true,
        success: false,
        hasHookError: true,
      }),
    ).toMatchObject({
      lastMessageRole: "assistant",
      finalTextState: "visible",
      lastAssistantStopReason: "stop",
    });
  });
  it.each([
    ["visible", [{ type: "text" as const, text: "Synthetic answer" }]],
    ["silent", [{ type: "text" as const, text: "NO_REPLY" }]],
    ["empty", []],
    ["reasoning_only", [{ type: "thinking" as const, thinking: "Synthetic reasoning" }]],
    ["non_text", [{ type: "toolCall" as const, id: "call", name: "read", arguments: {} }]],
  ] as const)("keeps %s distinct without retaining message content", (expected, content) => {
    const terminalMessage = makeAgentAssistantMessage({ content: [...content] });
    const observed = captureAgentTerminalSnapshot({
      terminalMessage,
      reachedPromptBoundary: true,
      success: true,
      hasHookError: false,
    });
    expect(observed.finalTextState).toBe(expected);
    expect(JSON.stringify(observed)).not.toContain("Synthetic");
    expect(
      captureAgentTerminalSnapshot({
        terminalMessage,
        reachedPromptBoundary: false,
        success: false,
        hasHookError: false,
      }),
    ).toMatchObject({
      lastMessageRole: "unknown",
      finalTextState: "unknown",
      errorSource: "unknown",
    });
  });

  it("retains raw error identity without reading causes or publishing metadata in JSON", () => {
    const original = new Error("synthetic provider failure");
    expect(withAgentTerminalSnapshot(original, snapshot)).toBe(original);
    expect(readAgentTerminalSnapshot(original)).toBe(snapshot);
    expect(JSON.stringify(original)).toBe("{}");
    expect(
      readAgentTerminalSnapshot(new Error("different failure", { cause: original })),
    ).toBeUndefined();
    withAgentTerminalSnapshot(original, undefined);
    expect(readAgentTerminalSnapshot(original)).toBeUndefined();
  });

  it("keeps frozen and non-Error exceptions unavailable", () => {
    const frozen = Object.freeze(new Error("synthetic frozen failure"));
    expect(withAgentTerminalSnapshot(frozen, snapshot)).toBe(frozen);
    expect(readAgentTerminalSnapshot(frozen)).toBeUndefined();
    const laterFrozen = withAgentTerminalSnapshot(new Error("later frozen"), snapshot);
    Object.freeze(laterFrozen);
    expect(readAgentTerminalSnapshot(laterFrozen)).toBeUndefined();
    const nonError = { message: "synthetic opaque failure" };
    expect(withAgentTerminalSnapshot(nonError, snapshot)).toBe(nonError);
    expect(readAgentTerminalSnapshot(nonError)).toBeUndefined();
  });

  it.each([true, false])(
    "copies only the selected error through normalization and fallback exhaustion (%s)",
    (selectedHasSnapshot) => {
      const earlier = withAgentTerminalSnapshot(new Error("earlier failure"), snapshot);
      const selected = new Error("429 rate limit exceeded", { cause: earlier });
      if (selectedHasSnapshot) {
        withAgentTerminalSnapshot(selected, snapshot);
      }
      const normalized = coerceToFailoverError(selected, { provider: "test", model: "model" });
      expect(normalized).not.toBeNull();
      expect(readAgentTerminalSnapshot(normalized)).toBe(
        selectedHasSnapshot ? snapshot : undefined,
      );
      try {
        throwFallbackFailureSummary({
          attempts: [
            { provider: "test", model: "first", reason: "unknown", error: earlier.message },
            { provider: "test", model: "model", reason: "rate_limit", error: selected.message },
          ],
          candidates: [
            { provider: "test", model: "first" },
            { provider: "test", model: "model" },
          ],
          lastError: normalized,
          label: "models",
          formatAttempt: (attempt) => attempt.error ?? "",
        });
      } catch (error) {
        expect(readAgentTerminalSnapshot(error)).toBe(selectedHasSnapshot ? snapshot : undefined);
        return;
      }
      throw new Error("expected fallback exhaustion");
    },
  );
});

describe("exact native payload ownership", () => {
  it("keeps ownership private and does not inherit through clones, prototypes, or freezing", () => {
    const original = withAgentTerminalPayloadSnapshot(
      { text: "Synthetic failure", isError: true },
      snapshot,
    );
    expect(readAgentTerminalPayloadSnapshot(original)).toBe(snapshot);
    expect(JSON.stringify(original)).not.toContain("agentSuccess");
    expect(readAgentTerminalPayloadSnapshot({ ...original })).toBeUndefined();
    expect(readAgentTerminalPayloadSnapshot(Object.create(original))).toBeUndefined();
    Object.freeze(original);
    expect(readAgentTerminalPayloadSnapshot(original)).toBeUndefined();
    const error = withAgentTerminalSnapshot(new Error("Selected native failure"), snapshot);
    expect(readAgentTerminalSnapshot(Object.create(error))).toBeUndefined();
  });
});
