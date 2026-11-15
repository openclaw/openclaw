import * as cjk from "@openclaw/normalization-core/cjk-chars";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freezeTrustedJsonSnapshot } from "../../shared/immutable-data.js";
import type { AgentMessage } from "../runtime/index.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  createFreshLlmBoundaryTokenEstimator,
  createFixedRequestTokenEstimator,
  estimateMessageTokenPressure,
  estimateToolSchemaTokens,
} from "./context-token-pressure.js";

vi.mock("@openclaw/normalization-core/cjk-chars", async (importOriginal) => {
  const actual = await importOriginal<typeof cjk>();
  return { ...actual, estimateStringTokenPressure: vi.fn(actual.estimateStringTokenPressure) };
});

beforeEach(() => {
  vi.mocked(cjk.estimateStringTokenPressure).mockClear();
});

describe("prepared context pressure", () => {
  it("retains golden estimates for CJK, images, calls, and a large result across readers", () => {
    const messages = (
      [
        { role: "user", content: "中A𠀀", timestamp: 1 },
        {
          role: "user",
          content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
          timestamp: 2,
        },
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: "c", name: "read", arguments: { path: "中" } }],
        }),
        {
          role: "toolResult",
          toolCallId: "c",
          toolName: "read",
          content: [{ type: "text", text: "中abc".repeat(20_000) }],
          isError: false,
          timestamp: 4,
        },
      ] satisfies AgentMessage[]
    ).map(freezeTrustedJsonSnapshot);
    const estimate = createFreshLlmBoundaryTokenEstimator({ systemPrompt: "sys" });
    expect(messages.map(estimateMessageTokenPressure)).toEqual([18, 2_012, 28, 35_020]);
    expect(estimate({ messages, prompt: "next" })).toBe(44_525);
    vi.mocked(cjk.estimateStringTokenPressure).mockClear();
    expect(messages.map(estimateMessageTokenPressure)).toEqual([18, 2_012, 28, 35_020]);
    expect(cjk.estimateStringTokenPressure).not.toHaveBeenCalled();
  });

  it("shares frozen content but observes mutable envelopes, replacement content, and mutable blocks", () => {
    const message: AgentMessage = {
      role: "custom",
      customType: "context",
      display: false,
      content: freezeTrustedJsonSnapshot([{ type: "text", text: "中A𠀀" }]),
      timestamp: 1,
    };
    expect(estimateMessageTokenPressure(message)).toBe(24);
    vi.mocked(cjk.estimateStringTokenPressure).mockClear();
    expect(estimateMessageTokenPressure({ ...message })).toBe(24);
    expect(cjk.estimateStringTokenPressure).not.toHaveBeenCalled();
    expect(estimateMessageTokenPressure({ ...message, excludeFromContext: true })).toBe(0);
    const block = { type: "text" as const, text: "a" };
    message.content = [block];
    expect(estimateMessageTokenPressure(message)).toBe(19);
    block.text = "中".repeat(100);
    expect(estimateMessageTokenPressure(message)).toBe(118);
  });

  it("shares whole-set schema rounding across readers and invalidates changed definitions", () => {
    const tools = [{ name: "a", description: "b", parameters: freezeTrustedJsonSnapshot({}) }];
    const otherTools = [{ name: "c", description: "d", parameters: freezeTrustedJsonSnapshot({}) }];
    const estimate = createFixedRequestTokenEstimator();
    const other = createFixedRequestTokenEstimator();
    expect(estimate({ tools }).toolTokens).toBe(24);
    expect(other({ tools: otherTools }).toolTokens).toBe(24);
    vi.mocked(cjk.estimateStringTokenPressure).mockClear();
    expect(estimate({ tools: [...tools] }).toolTokens).toBe(24);
    expect(other({ tools: [...otherTools] }).toolTokens).toBe(24);
    expect(cjk.estimateStringTokenPressure).not.toHaveBeenCalled();
    tools[0]!.description = "中".repeat(100);
    expect(estimate({ tools }).toolTokens).toBe(157);
    tools[0]!.parameters = { description: "a" };
    const before = estimate({ tools }).toolTokens;
    Object.assign(tools[0]!.parameters, { description: "中".repeat(100) });
    expect(estimate({ tools }).toolTokens).toBeGreaterThan(before);
    tools.push(otherTools[0]!);
    expect(estimate({ tools }).toolTokens).toBeGreaterThan(estimateToolSchemaTokens([tools[0]!]));
  });
});
