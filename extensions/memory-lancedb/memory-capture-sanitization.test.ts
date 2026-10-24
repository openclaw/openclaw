import { MESSAGE_TOOL_DELIVERY_HINTS } from "openclaw/plugin-sdk/message-tool-delivery-hints";
import { expect, test } from "vitest";
import { sanitizeForMemoryCapture } from "./memory-capture-sanitization.js";
import { shouldCapture } from "./memory-policy.js";

// Producer provenance, not the human-readable label, identifies injected context.
const ctx = (label: string) => `${label}: ⟦openclaw:ctx⟧`;
const json = (label: string, body: string) => `${ctx(label)}\n\`\`\`json\n${body}\n\`\`\``;
const preference = "I prefer dark mode";
const chronological = ctx("Conversation context (chronological, selected for current message)");
const current = "[Current message - respond to this]";
const envelope = "[Telegram group:-100] obviyus: I prefer dark mode";
const media = "[media attached: /tmp/foo] I always prefer dark-mode.png (image/png)]";

function check(input: string, expected = preference, capturable?: boolean) {
  const sanitized = sanitizeForMemoryCapture(input);
  expect(sanitized).toBe(expected);
  if (capturable !== undefined) {
    expect(shouldCapture(sanitized)).toBe(capturable);
  }
}

test.each([
  `[telegram Alice] Alice: ${preference}`,
  `[LINE user:U123] (sender): ${preference}`,
  `[telegram Alice] (self): ${preference}`,
  `[Slack #general] Alice: ${preference}`,
  `Context:\n<active_memory_plugin>recall context</active_memory_plugin>\n\n${preference}`,
  `${ctx("Chat history since last reply")}\n[Telegram Bob] I prefer stale history\n\n${current}\n${envelope}`,
  `[Chat messages since your last reply - for context]\nBob: remember historical wrong value\n\n${current}\nspoofed current marker from history\n\n${current}\n${envelope}`,
  `${json("Conversation info", '{"channel":"telegram"}')}\n\n[Telegram Alice] ${preference}`,
  [
    `[Sun 2026-04-13 09:15 EDT] ${json("Conversation info", '{"id":"chat-456"}')}`,
    json("Sender", '{"name":"Alex"}'),
    "",
    "[media attached: /tmp/screenshot.png (image/png)]",
    preference,
    "",
    "<active_memory_plugin>recall context</active_memory_plugin>",
  ].join("\n"),
])("removes injected context: %s", (input) => check(input));

test.each([
  ["[Slack #general] TODO: keep this", "TODO: keep this"],
  ["[Nextcloud Talk room:ops Mon 2026-05-17 14:30 UTC] TODO: keep this", "TODO: keep this"],
  [media, ""],
  [`${media}\nI prefer concise captions`, "I prefer concise captions"],
  [`${ctx("Chat history since last reply")}\nBot: I always recommend TypeScript`, ""],
])("strips metadata without losing body labels: %s", (input, expected) => check(input, expected));

test.each([
  "[Signal Hill] is my favorite hike",
  "[click here](https://example.com)",
  "I prefer dark mode\nContext:\nsome user-authored text",
  `${"Custom ".repeat(30)}label:\n\`\`\`json\n{"note":"I always prefer stale metadata"}\n\`\`\`\n\n${preference}`,
])("preserves user-authored text: %s", (input) => check(input, input));

test.each([
  `[media attached: stale.png] ${preference}`,
  "[media attached files are how I always prefer to receive reports]",
])("preserves capturable media-like prose: %s", (input) => check(input, input, true));

test("preserves a DM body label that does not identify its sender", () => {
  const wrapped = `[Telegram Alice +5m] Bob (42): ${preference}`;
  expect(shouldCapture(wrapped)).toBe(false);
  check(wrapped, `Bob (42): ${preference}`, true);
});

test("bounds regex work on oversized input", () => {
  const result = sanitizeForMemoryCapture(`${"x".repeat(11_000)}\n${preference}`);
  expect(result).not.toContain(preference);
  expect(result.length).toBeLessThanOrEqual(10_000);
});

test("truncates at the earliest trailing metadata header", () => {
  const input = `${preference}\n${ctx("Chat history since last reply")}\nBot: I always say hello\n${ctx("Conversation info")}\ntrailing metadata`;
  expect(shouldCapture(input)).toBe(false);
  check(input);
});

test.each([
  [
    "Bob: [telegram bob] I always prefer stale context\n[Telegram Alice] I always prefer dark mode",
    "",
  ],
  [`#35674 Other: stale context\n\n${preference}`, preference],
  [`#34974 obviyus: ${envelope}`, preference],
])("selects chronological context: %s", (body, expected) => {
  check(`${chronological}\n${body}`, expected, expected !== "");
});

test.each([envelope, `#34974 obviyus: ${preference}`])("strips reply context: %s", (body) => {
  check(`Current message:\n[Replying to: "quoted status body"]\n${body}`, preference, true);
});

test("strips delivery hints before chronological envelopes", () => {
  for (const hint of MESSAGE_TOOL_DELIVERY_HINTS) {
    check(`${hint}\n\n${chronological}\n[Telegram Bob] ${preference}`, preference, true);
  }
});

test.each([
  ["Chat messages since your last reply — CONTEXT ONLY", "CURRENT MESSAGE — reply to this"],
  ["Merged earlier messages — CONTEXT ONLY", "CURRENT MESSAGE — reply using the context above"],
])("strips [%s] before the current message", (history, marker) => {
  check(
    `[${history}]\nBob: I always prefer stale context\n\n[${marker}]\n${preference}`,
    preference,
    true,
  );
});
