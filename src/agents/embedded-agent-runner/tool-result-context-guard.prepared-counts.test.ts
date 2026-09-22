import { estimateStringCharsWithMinimumRawWeight } from "@openclaw/normalization-core/cjk-chars";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
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
  const dispose = installToolResultContextGuard({ agent, contextWindowTokens: 8_192 });
  return {
    dispose,
    run: async (source: AgentMessage) => {
      const transform = agent.transformContext;
      if (!transform) {
        throw new Error("guard did not install its context transform");
      }
      return await transform([source], new AbortController().signal);
    },
  };
}

function fullTextScans(text: string) {
  return countChars.mock.calls.filter(([value]) => value === text).length;
}

beforeEach(() => {
  countChars.mockClear();
});

describe("prepared counts through the tool-result context guard", () => {
  it.each([false, true])(
    "counts each retained source block once before truncation (images: %s)",
    async (images) => {
      const text = "progress 漢字🙂𠀀\n".repeat(1_024);
      const source = toolResult([
        { type: "text", text },
        { type: "text", text },
        { type: "text", text: "" },
        ...(images ? [{ type: "image" as const, data: "AQ==", mimeType: "image/png" }] : []),
      ]);
      const original = structuredClone(source);
      const guard = guarded();
      try {
        const first = await guard.run(source);
        expect(JSON.stringify(first)).toContain("more characters truncated");
        expect(fullTextScans(text)).toBe(2);

        countChars.mockClear();
        const second = await guard.run(source);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        expect(fullTextScans(text)).toBe(0);
        expect(source).toEqual(original);
      } finally {
        guard.dispose();
      }
    },
  );

  it("recounts a changed text revision on the same retained block", async () => {
    const block = { type: "text" as const, text: "before 漢字\n".repeat(2_048) };
    const source = toolResult([block]);
    const guard = guarded();
    try {
      await guard.run(source);
      block.text = "after 🙂𠀀\n".repeat(2_048);
      const original = structuredClone(source);
      countChars.mockClear();
      const revised = await guard.run(source);
      expect(fullTextScans(block.text)).toBe(1);

      const fresh = await guard.run(structuredClone(source));
      expect(JSON.stringify(revised)).toBe(JSON.stringify(fresh));
      expect(source).toEqual(original);
    } finally {
      guard.dispose();
    }
  });

  it("does not populate preparation facts when truncation reads an uncached block", async () => {
    const text = "uncached 漢字🙂\n".repeat(2_048);
    const source = toolResult([{ type: "text", text }]);
    truncateToolResultMessage(source, 4_096, { minimumRawWeight: 2 });
    countChars.mockClear();
    const guard = guarded();
    try {
      await guard.run(source);
      expect(fullTextScans(text)).toBe(1);
    } finally {
      guard.dispose();
    }
  });

  it.each([
    [undefined, 2_000],
    [1, 2_000],
    [1.5, 2_300],
    [3, 3_000],
  ] as const)("keeps floor %s independent of a prepared floor-2 count", async (floor, budget) => {
    const source = toolResult([{ type: "text", text: "aé😀漢".repeat(200) }]);
    const guard = guarded();
    try {
      await guard.run(source);
      const fresh = structuredClone(source);
      const options = { minimumRawWeight: floor };
      const expected = truncateToolResultMessage(fresh, budget, options);
      const actual = truncateToolResultMessage(source, budget, options);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
      expect(actual === source).toBe(expected === fresh);
    } finally {
      guard.dispose();
    }
  });

  it("leaves legacy text blocks on the uncached counting path", () => {
    const text = "legacy 漢字🙂\n".repeat(1_024);
    const source = castAgentMessage({
      ...toolResult([]),
      content: [{ type: "toolResult", text }],
    });
    const first = truncateToolResultMessage(source, 4_096, { minimumRawWeight: 2 });
    expect(fullTextScans(text)).toBeGreaterThan(0);
    countChars.mockClear();
    const second = truncateToolResultMessage(source, 4_096, { minimumRawWeight: 2 });
    expect(fullTextScans(text)).toBeGreaterThan(0);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
