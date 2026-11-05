import { describe, expect, it, vi } from "vitest";
import { normalizePluginConfig } from "./config.js";
import { buildPromptPrefix } from "./prompt.js";
import { buildQuery, buildSearchQuery, extractRecentTurns } from "./query.js";

// mock-isolation: Keep unrelated model discovery and its runtime graph out of query assembly tests.
vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  DEFAULT_PROVIDER: "anthropic",
  parseModelRef: vi.fn(),
  resolveAgentEffectiveModelPrimary: vi.fn(),
  resolveDefaultModelForAgent: vi.fn(),
}));

describe("active-memory search queries", () => {
  it.each([
    [
      `what should I pack?\n\n${buildPromptPrefix("User prefers aisle seats.")}`,
      [],
      "what should I pack?",
    ],
    ["Context: my project uses TypeScript", [], "Context: my project uses TypeScript"],
    [
      "why?",
      [{ role: "user" as const, text: `${"x".repeat(119)}🚀tail` }],
      `${"x".repeat(119)} why?`,
    ],
  ])("builds a safe query from %#", (latestUserMessage, recentTurns, expected) => {
    const query = buildSearchQuery({ latestUserMessage, recentTurns });
    expect(query).toBe(expected);
    expect(query).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });
});

describe("active-memory recent turn block boundaries", () => {
  const header = "Context:";
  const open = "<active_memory_plugin>";
  const close = "</active_memory_plugin>";

  it.each([
    {
      name: "multiple blocks after an earlier close",
      lines: [
        close,
        "before",
        header,
        open,
        "hidden",
        close,
        "middle",
        header,
        open,
        "hidden",
        close,
        "after",
      ],
      assistant: "before middle after",
      user: `${close} before middle after`,
    },
    {
      name: "a physical blank between header and open",
      lines: [header, "", open, "visible", close, "after"],
      assistant: "after",
      user: `${header} ${open} visible ${close} after`,
    },
    {
      name: "an unclosed block",
      lines: [header, open, "visible"],
      assistant: `${open} visible`,
      user: `${header} ${open} visible`,
    },
    {
      name: "the first close after nested opening text",
      lines: [header, open, "outer", open, "inner", close, "tail", close, "after"],
      assistant: "tail after",
      user: `tail ${close} after`,
    },
    {
      name: "trimmed CRLF markers",
      lines: [` ${header} \r`, `\t${open}\r`, "hidden\r", ` ${close} \r`, " after "],
      assistant: "after",
      user: "after",
    },
    {
      name: "a block-only turn",
      lines: [header, open, "hidden", close],
      assistant: "",
      user: "",
    },
  ])("preserves role-specific cleanup for $name", ({ lines, assistant, user }) => {
    const content = lines.join("\n");
    for (const [role, text] of [
      ["assistant", assistant],
      ["user", user],
    ] as const) {
      expect(extractRecentTurns([{ role, content }])).toEqual(text ? [{ role, text }] : []);
    }
  });
});

describe("active-memory recall query limits", () => {
  it.each([
    ["message", "current question"],
    [
      "recent",
      "Recent conversation tail:\nuser: older question\nassistant: previous reply\n\nLatest user message:\ncurrent question",
    ],
    [
      "full",
      "Full conversation context:\nuser: older question\nassistant: previous reply\n\nLatest user message:\ncurrent question",
    ],
  ] as const)("preserves under-limit %s query formatting", (queryMode, expected) => {
    expect(
      buildQuery({
        latestUserMessage: " current question ",
        recentTurns: [
          { role: "user", text: " older   question " },
          { role: "assistant", text: " previous\nreply " },
        ],
        config: normalizePluginConfig({ queryMode }),
      }),
    ).toBe(expected);
  });

  it.each(["message", "recent", "full"] as const)(
    "preserves a current request at the limit in %s mode without overflowing headers",
    (queryMode) => {
      const latest = "x".repeat(4_000);
      expect(
        buildQuery({
          latestUserMessage: latest,
          recentTurns: [{ role: "user", text: "previous question" }],
          config: normalizePluginConfig({ queryMode }),
        }),
      ).toBe(latest);
    },
  );

  it.each(["message", "recent", "full"] as const)(
    "retains quoted context and the final question in an oversized %s request",
    (queryMode) => {
      const head = '[Replying to: "QUOTED_REPLY_SENTINEL"]\n';
      const question = "What is my synthetic access phrase?";
      const query = buildQuery({
        latestUserMessage: head + "🦞".repeat(15_000) + question,
        recentTurns: [{ role: "user", text: "old history" }],
        config: normalizePluginConfig({ queryMode }),
      });
      expect(query.length).toBeLessThanOrEqual(4_000);
      expect(query.startsWith(head)).toBe(true);
      expect(query.endsWith(question)).toBe(true);
      expect(query).toContain("[Middle of current request omitted]");
      expect(query).not.toContain("old history");
      expect(query).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
    },
  );

  it("keeps the newest history without changing the current message", () => {
    const latest = '[Replying to: "quoted context"]\nWhat was the decision?';
    const query = buildQuery({
      latestUserMessage: latest,
      recentTurns: [
        { role: "user", text: "OLDEST_HISTORY " + "🦞".repeat(12_000) },
        { role: "assistant", text: "NEWEST_HISTORY" },
      ],
      config: normalizePluginConfig({ queryMode: "full" }),
    });
    expect(query.length).toBeLessThanOrEqual(4_000);
    expect(query).toContain("[Older conversation content omitted]");
    expect(query).not.toContain("OLDEST_HISTORY");
    expect(query).toContain("assistant: NEWEST_HISTORY");
    expect(query.endsWith(`Latest user message:\n${latest}`)).toBe(true);
    expect(query).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });
});
