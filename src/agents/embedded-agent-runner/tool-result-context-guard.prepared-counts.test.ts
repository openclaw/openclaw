import { expectDefined } from "@openclaw/normalization-core";
import { estimateStringCharsWithMinimumRawWeight } from "@openclaw/normalization-core/cjk-chars";
import type { Agent, AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { freezeTrustedJsonSnapshot } from "../../shared/immutable-data.js";
import { installToolResultContextGuard } from "./tool-result-context-guard.js";
import {
  truncateOversizedToolResultsInMessages,
  truncateToolResultMessage,
} from "./tool-result-truncation.js";

vi.mock("@openclaw/normalization-core/cjk-chars", { spy: true });

const countChars = vi.mocked(estimateStringCharsWithMinimumRawWeight);
type ToolContent = Extract<AgentMessage, { role: "toolResult" }>["content"];

function toolResult(content: ToolContent): Extract<AgentMessage, { role: "toolResult" }> {
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
  const agent: Pick<Agent, "transformContext"> = {};
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

it("refreshes prepared counts when the retained text changes", async () => {
  const block = {
    type: "text" as const,
    text: "before 漢字\n".repeat(2_048),
  };
  const source = toolResult([block]);
  const run = guarded();
  await run(source);
  block.text = "after 🙂𠀀\n".repeat(2_048);
  const revised = structuredClone(source);
  countChars.mockClear();
  const second = await run(source);
  expect(fullTextScans(block.text)).toBe(1);
  expect(JSON.stringify(second)).toBe(JSON.stringify(await run(structuredClone(source))));
  expect(source).toEqual(revised);
});

it("keeps a fractional floor independent of a prepared floor-2 count", async () => {
  const source = toolResult([{ type: "text", text: "aé😀漢".repeat(200) }]);
  await guarded()(source);
  const fresh = structuredClone(source);
  const options = { minimumRawWeight: 1.5 };
  const expected = truncateToolResultMessage(fresh, 2_300, options);
  const actual = truncateToolResultMessage(source, 2_300, options);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  expect(actual === source).toBe(expected === fresh);
});

it("reuses frozen history sizes across requests and still measures changed content", () => {
  const truncate = truncateOversizedToolResultsInMessages;
  const text = "historical 漢字🙂\n".repeat(128);
  const source = toolResult(freezeTrustedJsonSnapshot([{ type: "text", text }]));
  const history = [source];
  expect(truncate(history, 128_000).messages).toBe(history);
  countChars.mockClear();
  expect(truncate([...history], 128_000).messages[0]).toBe(source);
  expect(fullTextScans(text)).toBe(0);

  const mutableBlock = { type: "text" as const, text: "short" };
  const mutableContent = [mutableBlock];
  Object.freeze(mutableContent);
  const changed = toolResult(mutableContent);
  expect(truncate([changed], 128_000, 1_000).messages[0]).toBe(changed);
  mutableBlock.text = text;
  expect(truncate([changed], 128_000, 1_000).truncatedCount).toBe(1);
  expect(truncate(history, 128_000, 1_000).truncatedCount).toBe(1);
  expect(source.content).toEqual([{ type: "text", text }]);
});

it("does not rescan cold oversized text before truncating it", () => {
  const text = "cold output 漢字\n".repeat(2_048);
  const source = toolResult([{ type: "text", text }]);
  expect(truncateToolResultMessage(source, 1_000)).not.toBe(source);
  expect(fullTextScans(text)).toBe(1);
  countChars.mockClear();
  expect(truncateOversizedToolResultsInMessages([source], 128_000, 1_000).truncatedCount).toBe(1);
  expect(fullTextScans(text)).toBe(2);
});
