import { describe, expect, it, vi } from "vitest";
import { normalizePluginConfig } from "./config.js";
import { buildPromptPrefix } from "./prompt.js";
import { buildQuery, buildSearchQuery, extractRecentTurns } from "./query.js";
import type { ActiveRecallRecentTurn, ResolvedActiveRecallPluginConfig } from "./types.js";

const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const recallQuery = (
  queryMode: ResolvedActiveRecallPluginConfig["queryMode"],
  latestUserMessage: string,
  recentTurns: ActiveRecallRecentTurn[] = [],
) => buildQuery({ latestUserMessage, recentTurns, config: normalizePluginConfig({ queryMode }) });

// mock-isolation: Keep unrelated model discovery and its runtime graph out of query assembly tests.
vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  DEFAULT_PROVIDER: "anthropic",
  parseModelRef: vi.fn(),
  resolveAgentEffectiveModelPrimary: vi.fn(),
  resolveDefaultModelForAgent: vi.fn(),
}));

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
  expect(query).not.toMatch(UNPAIRED_SURROGATE);
});

const header = "Context:";
const open = "<active_memory_plugin>";
const close = "</active_memory_plugin>";

it.each`
  name                                           | content                                                                                                          | assistant                | user
  ${"multiple blocks after an earlier close"}    | ${`${close}\nbefore\n${header}\n${open}\nhidden\n${close}\nmiddle\n${header}\n${open}\nhidden\n${close}\nafter`} | ${"before middle after"} | ${`${close} before middle after`}
  ${"a physical blank between header and open"}  | ${`${header}\n\n${open}\nvisible\n${close}\nafter`}                                                              | ${"after"}               | ${`${header} ${open} visible ${close} after`}
  ${"an unclosed block"}                         | ${`${header}\n${open}\nvisible`}                                                                                 | ${`${open} visible`}     | ${`${header} ${open} visible`}
  ${"the first close after nested opening text"} | ${`${header}\n${open}\nouter\n${open}\ninner\n${close}\ntail\n${close}\nafter`}                                  | ${"tail after"}          | ${`tail ${close} after`}
  ${"trimmed CRLF markers"}                      | ${` ${header} \r\n\t${open}\r\nhidden\r\n ${close} \r\n after `}                                                 | ${"after"}               | ${"after"}
  ${"a block-only turn"}                         | ${`${header}\n${open}\nhidden\n${close}`}                                                                        | ${""}                    | ${""}
`(
  "preserves role-specific cleanup for $name",
  ({ content, assistant, user }: { content: string; assistant: string; user: string }) => {
    for (const [role, text] of [
      ["assistant", assistant],
      ["user", user],
    ] as const) {
      expect(extractRecentTurns([{ role, content }])).toEqual(text ? [{ role, text }] : []);
    }
  },
);

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
      recallQuery(queryMode, " current question ", [
        { role: "user", text: " older   question " },
        { role: "assistant", text: " previous\nreply " },
      ]),
    ).toBe(expected);
  });

  it.each(["message", "recent", "full"] as const)(
    "preserves a current request at the limit in %s mode without overflowing headers",
    (queryMode) => {
      const latest = "x".repeat(4_000);
      expect(recallQuery(queryMode, latest, [{ role: "user", text: "previous question" }])).toBe(
        latest,
      );
    },
  );

  it.each(["message", "recent", "full"] as const)(
    "retains quoted context and the final question in an oversized %s request",
    (queryMode) => {
      const head = '[Replying to: "QUOTED_REPLY_SENTINEL"]\n';
      const question = "What is my synthetic access phrase?";
      const query = recallQuery(queryMode, head + "🦞".repeat(15_000) + question, [
        { role: "user", text: "old history" },
      ]);
      expect(query.length).toBeLessThanOrEqual(4_000);
      expect(query.startsWith(head)).toBe(true);
      expect(query.endsWith(question)).toBe(true);
      expect(query).toContain("[Middle of current request omitted]");
      expect(query).not.toContain("old history");
      expect(query).not.toMatch(UNPAIRED_SURROGATE);
    },
  );

  it("keeps the newest history without changing the current message", () => {
    const latest = '[Replying to: "quoted context"]\nWhat was the decision?';
    const query = recallQuery("full", latest, [
      { role: "user", text: "OLDEST_HISTORY " + "🦞".repeat(12_000) },
      { role: "assistant", text: "NEWEST_HISTORY" },
    ]);
    expect(query.length).toBeLessThanOrEqual(4_000);
    expect(query).toContain("[Older conversation content omitted]");
    expect(query).not.toContain("OLDEST_HISTORY");
    expect(query).toContain("assistant: NEWEST_HISTORY");
    expect(query.endsWith(`Latest user message:\n${latest}`)).toBe(true);
    expect(query).not.toMatch(UNPAIRED_SURROGATE);
  });
});
