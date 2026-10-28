import { expectDefined } from "@openclaw/normalization-core";
import { estimateStringCharsWithMinimumRawWeight } from "@openclaw/normalization-core/cjk-chars";
import type { Agent, AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { freezeTrustedJsonSnapshot } from "../../shared/immutable-data.js";
import { cloneSessionModelContextEntries } from "../sessions/session-manager-codec.js";
import { toolResult } from "../sessions/session-message-fixtures.test-support.js";
import { installToolResultContextGuard } from "./tool-result-context-guard.js";
import {
  truncateOversizedToolResultsInMessages as truncate,
  truncateToolResultMessage,
} from "./tool-result-truncation.js";

vi.mock("@openclaw/normalization-core/cjk-chars", { spy: true });

const countChars = vi.mocked(estimateStringCharsWithMinimumRawWeight);
function guarded() {
  const agent: Pick<Agent, "transformContext"> = {};
  onTestFinished(installToolResultContextGuard({ agent, contextWindowTokens: 8_192 }));
  const transform = expectDefined(agent.transformContext, "installed guard");
  return (source: AgentMessage) => transform([source], new AbortController().signal);
}

function fullTextScans(text: string) {
  return countChars.mock.calls.filter(([value]) => value === text).length;
}

beforeEach(() => void countChars.mockClear());

it("refreshes prepared counts when the retained text changes", async () => {
  const source = toolResult("before 漢字\n".repeat(2_048));
  const block = expectDefined(source.content[0], "text block");
  const run = guarded();
  await run(source);
  block.text = "after 🙂𠀀\n".repeat(2_048);
  countChars.mockClear();
  const second = await run(source);
  expect(fullTextScans(block.text)).toBe(1);
  expect(JSON.stringify(second)).toBe(JSON.stringify(await run(structuredClone(source))));
});

it("keeps a fractional floor independent of a prepared floor-2 count", async () => {
  const source = toolResult("aé😀漢".repeat(200));
  await guarded()(source);
  const fresh = structuredClone(source);
  const options = { minimumRawWeight: 1.5 };
  const expected = truncateToolResultMessage(fresh, 2_300, options);
  const actual = truncateToolResultMessage(source, 2_300, options);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  expect(actual === source).toBe(expected === fresh);
});

it.each(["frozen", "initial-context"])("reuses %s history budgets", async (kind) => {
  const text = "historical 漢字🙂\n".repeat(128);
  let source: AgentMessage = freezeTrustedJsonSnapshot(toolResult(text));
  if (kind === "initial-context") {
    const [entry] = cloneSessionModelContextEntries([
      {
        type: "message",
        id: "history",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: source,
      },
    ]);
    if (entry?.type !== "message" || entry.message.role !== "toolResult") {
      throw new Error("Missing model history");
    }
    source = entry.message;
    expect(Object.isFrozen(source.content)).toBe(false);
  }
  const history = [source];
  expect(truncate(history, 128_000).messages).toBe(history);
  const run = guarded();
  await run(source);
  truncate([...history], 128_000);
  countChars.mockClear();
  await run(source);
  expect(truncate([...history], 128_000).messages[0]).toBe(source);
  expect(fullTextScans(text)).toBe(0);

  const changed = toolResult("short");
  const mutableBlock = expectDefined(changed.content[0], "mutable text block");
  Object.freeze(changed.content);
  expect(truncate([changed], 128_000, 1_000).messages[0]).toBe(changed);
  mutableBlock.text = text;
  expect(truncate([changed], 128_000, 1_000).truncatedCount).toBe(1);
  expect(truncate(history, 128_000, 1_000).truncatedCount).toBe(1);
  expect(JSON.stringify(truncate(history, 128_000, 1_000))).toBe(
    JSON.stringify(truncate(structuredClone(history), 128_000, 1_000)),
  );
  expect(source.content).toEqual([{ type: "text", text }]);
});

it("does not rescan cold oversized text before truncating it", () => {
  const text = "cold output 漢字\n".repeat(2_048);
  const source = toolResult(text);
  expect(truncateToolResultMessage(source, 1_000)).not.toBe(source);
  expect(fullTextScans(text)).toBe(1);
  countChars.mockClear();
  expect(truncate([source], 128_000, 1_000).truncatedCount).toBe(1);
  expect(fullTextScans(text)).toBe(0);
});
