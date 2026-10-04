import { expectDefined } from "@openclaw/normalization-core";
import { estimateStringCharsWithMinimumRawWeight } from "@openclaw/normalization-core/cjk-chars";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { installToolResultContextGuard } from "./tool-result-context-guard.js";
import { truncateToolResultMessage } from "./tool-result-truncation.js";

vi.mock("@openclaw/normalization-core/cjk-chars", { spy: true });

const countChars = vi.mocked(estimateStringCharsWithMinimumRawWeight);
type ToolContent = Extract<AgentMessage, { role: "toolResult" }>["content"];

function toolResult(content: ToolContent): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "prepared-counts",
    toolName: "read",
    content,
    isError: false,
    timestamp: 0,
  };
}

function guarded() {
  const agent: {
    transformContext?: (messages: AgentMessage[], signal: AbortSignal) => unknown;
  } = {};
  onTestFinished(installToolResultContextGuard({ agent, contextWindowTokens: 8_192 }));
  return (source: AgentMessage) =>
    expectDefined(agent.transformContext, "installed guard")(
      [source],
      new AbortController().signal,
    );
}

function fullTextScans(text: string) {
  return countChars.mock.calls.filter(([value]) => value === text).length;
}

beforeEach(() => {
  countChars.mockClear();
});

it.each([false, true])(
  "reuses prepared counts unless the retained text changes (%s)",
  async (revise) => {
    const block = {
      type: "text" as const,
      text: revise ? "before 漢字\n".repeat(2_048) : "progress 漢字🙂𠀀\n".repeat(1_024),
    };
    const source = toolResult(
      revise
        ? [block]
        : [
            block,
            { ...block },
            { type: "text", text: "" },
            { type: "image", data: "AQ==", mimeType: "image/png" },
          ],
    );
    const original = structuredClone(source);
    const run = guarded();
    const first = await run(source);
    if (revise) {
      block.text = "after 🙂𠀀\n".repeat(2_048);
    } else {
      expect(JSON.stringify(first)).toContain("more characters truncated");
      expect(fullTextScans(block.text)).toBe(2);
      expect(source).toEqual(original);
    }
    const revised = revise ? structuredClone(source) : original;
    countChars.mockClear();
    const second = await run(source);
    expect(fullTextScans(block.text)).toBe(revise ? 1 : 0);
    expect(JSON.stringify(second)).toBe(
      JSON.stringify(revise ? await run(structuredClone(source)) : first),
    );
    expect(source).toEqual(revised);
  },
);

it.each([
  [undefined, 2_000],
  [1.5, 2_300],
] as const)("keeps floor %s independent of a prepared floor-2 count", async (floor, budget) => {
  const source = toolResult([{ type: "text", text: "aé😀漢".repeat(200) }]);
  await guarded()(source);
  const fresh = structuredClone(source);
  const options = { minimumRawWeight: floor };
  const expected = truncateToolResultMessage(fresh, budget, options);
  const actual = truncateToolResultMessage(source, budget, options);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  expect(actual === source).toBe(expected === fresh);
});
