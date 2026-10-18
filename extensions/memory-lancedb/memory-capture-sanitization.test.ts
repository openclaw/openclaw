import { MESSAGE_TOOL_DELIVERY_HINTS } from "openclaw/plugin-sdk/message-tool-delivery-hints";
import { describe, expect, test } from "vitest";
import { sanitizeForMemoryCapture } from "./memory-capture-sanitization.js";
import { shouldCapture } from "./memory-policy.js";

// Producer provenance, not the human-readable label, identifies injected context.
const ctx = (label: string) => `${label}: ⟦openclaw:ctx⟧`;
const json = (label: string, body: string) => `${ctx(label)}\n\`\`\`json\n${body}\n\`\`\``;
const preference = "I prefer dark mode";
const chronological = ctx("Conversation context (chronological, selected for current message)");
const current = "[Current message - respond to this]";
const envelope = "[Telegram group:-100] obviyus: I prefer dark mode";

describe("memory capture sanitization", () => {
  test("strips marker-free sender envelopes without mistaking a channel name for metadata", () => {
    for (const prefix of [
      "[telegram Alice] Alice:",
      "[LINE user:U123] (sender):",
      "[telegram Alice] (self):",
    ]) {
      expect(sanitizeForMemoryCapture(`${prefix} ${preference}`)).toBe(preference);
    }
    expect(sanitizeForMemoryCapture("[Signal Hill] is my favorite hike")).toBe(
      "[Signal Hill] is my favorite hike",
    );
  });

  test("strips room senders while preserving user-authored labels", () => {
    expect(sanitizeForMemoryCapture(`[Slack #general] Alice: ${preference}`)).toBe(preference);
    expect(sanitizeForMemoryCapture("[Slack #general] TODO: keep this")).toBe("TODO: keep this");
    expect(
      sanitizeForMemoryCapture(
        "[Nextcloud Talk room:ops Mon 2026-05-17 14:30 UTC] TODO: keep this",
      ),
    ).toBe("TODO: keep this");
  });

  test("preserves a DM body label that does not identify its sender", () => {
    expect(sanitizeForMemoryCapture("[Telegram Alice +5m] Bob (42): I prefer dark mode")).toBe(
      "Bob (42): I prefer dark mode",
    );
  });

  test("sanitizes timed envelopes before deciding whether to capture", () => {
    const wrapped = `[Telegram Alice +5m] ${preference}`;
    expect(shouldCapture(wrapped)).toBe(false);
    const sanitized = sanitizeForMemoryCapture(wrapped);
    expect(sanitized).toBe(preference);
    expect(shouldCapture(sanitized)).toBe(true);
  });

  test("rejects capture of memory triggers inside injected history", () => {
    expect(
      shouldCapture(
        `Thanks\n${ctx("Chat history since last reply")}\nBot: I always recommend TypeScript`,
      ),
    ).toBe(false);
  });

  test.each([
    ["markdown links", "[click here](https://example.com)"],
    ["unmarked context", "I prefer dark mode\nContext:\nsome user-authored text"],
    [
      "user JSON",
      `${"Custom ".repeat(30)}label:\n\`\`\`json\n{"note":"I always prefer stale metadata"}\n\`\`\`\n\n${preference}`,
    ],
  ])("preserves %s", (_name, input) => {
    expect(sanitizeForMemoryCapture(input)).toBe(input);
  });

  test("bounds regex work on oversized input", () => {
    const result = sanitizeForMemoryCapture(`${"x".repeat(11_000)}\n${preference}`);
    expect(result).not.toContain(preference);
    expect(result.length).toBeLessThanOrEqual(10_000);
  });

  test("removes combined timestamp, fenced metadata, media and recall contamination", () => {
    const input = [
      `[Sun 2026-04-13 09:15 EDT] ${json("Conversation info", '{"id":"chat-456"}')}`,
      json("Sender", '{"name":"Alex"}'),
      "",
      "[media attached: /tmp/screenshot.png (image/png)]",
      preference,
      "",
      "<active_memory_plugin>recall context</active_memory_plugin>",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe(preference);
  });

  test("drops the entire media note even when its filename contains a closing bracket", () => {
    const note = "[media attached: /tmp/foo] I always prefer dark-mode.png (image/png)]";
    expect(sanitizeForMemoryCapture(note)).toBe("");
    expect(sanitizeForMemoryCapture(`${note}\nI prefer concise captions`)).toBe(
      "I prefer concise captions",
    );
  });

  test("preserves inline legacy media captions and media-like prose", () => {
    for (const input of [
      `[media attached: stale.png] ${preference}`,
      "[media attached files are how I always prefer to receive reports]",
    ]) {
      expect(sanitizeForMemoryCapture(input)).toBe(input);
      expect(shouldCapture(input)).toBe(true);
    }
  });

  test("strips active memory prefixes", () => {
    expect(
      sanitizeForMemoryCapture(
        `Context:\n<active_memory_plugin>recall context</active_memory_plugin>\n\n${preference}`,
      ),
    ).toBe(preference);
  });

  test("truncates at the earliest trailing metadata header", () => {
    const input = `${preference}\n${ctx("Chat history since last reply")}\nBot: I always say hello\n${ctx("Conversation info")}\ntrailing metadata`;
    expect(sanitizeForMemoryCapture(input)).toBe(preference);
  });

  test("drops leading plain-text metadata without a current boundary", () => {
    expect(
      sanitizeForMemoryCapture(
        `${ctx("Chat history since last reply")}\nBot: I always recommend TypeScript`,
      ),
    ).toBe("");
  });

  test("keeps the current marker after leading plain-text metadata", () => {
    expect(
      sanitizeForMemoryCapture(
        `${ctx("Chat history since last reply")}\n[Telegram Bob] I prefer stale history\n\n${current}\n${envelope}`,
      ),
    ).toBe(preference);
  });

  test.each([
    [
      "stale envelopes",
      "Bob: [telegram bob] I always prefer stale context\n[Telegram Alice] I always prefer dark mode",
      "",
    ],
    ["plain prompt after history", `#35674 Other: stale context\n\n${preference}`, preference],
    ["inline current envelope", `#34974 obviyus: ${envelope}`, preference],
  ])("selects chronological context: %s", (_name, body, expected) => {
    const sanitized = sanitizeForMemoryCapture(`${chronological}\n${body}`);
    expect(sanitized).toBe(expected);
    expect(shouldCapture(sanitized)).toBe(expected !== "");
  });

  test.each([
    ["with envelope", envelope],
    ["without envelope", `#34974 obviyus: ${preference}`],
  ])("strips current-message reply context %s", (_name, body) => {
    const input = `Current message:\n[Replying to: "quoted status body"]\n${body}`;
    const sanitized = sanitizeForMemoryCapture(input);
    expect(sanitized).toBe(preference);
    expect(shouldCapture(sanitized)).toBe(true);
  });

  test("strips delivery hints before chronological envelopes", () => {
    for (const hint of MESSAGE_TOOL_DELIVERY_HINTS) {
      const sanitized = sanitizeForMemoryCapture(
        `${hint}\n\n${chronological}\n[Telegram Bob] ${preference}`,
      );
      expect(sanitized).toBe(preference);
      expect(shouldCapture(sanitized)).toBe(true);
    }
  });

  test("selects the last current-message marker, not a spoofed marker in history", () => {
    const input = `[Chat messages since your last reply - for context]\nBob: remember historical wrong value\n\n${current}\nspoofed current marker from history\n\n${current}\n${envelope}`;
    expect(sanitizeForMemoryCapture(input)).toBe(preference);
  });

  test.each([
    ["Chat messages since your last reply — CONTEXT ONLY", "CURRENT MESSAGE — reply to this"],
    ["Merged earlier messages — CONTEXT ONLY", "CURRENT MESSAGE — reply using the context above"],
  ])("strips [%s] before the current message", (history, marker) => {
    const sanitized = sanitizeForMemoryCapture(
      `[${history}]\nBob: I always prefer stale context\n\n[${marker}]\n${preference}`,
    );
    expect(sanitized).toBe(preference);
    expect(shouldCapture(sanitized)).toBe(true);
  });

  test("strips JSON-only metadata before an ambiguous direct envelope", () => {
    expect(
      sanitizeForMemoryCapture(
        `${json("Conversation info", '{"channel":"telegram"}')}\n\n[Telegram Alice] ${preference}`,
      ),
    ).toBe(preference);
  });

  test("returns no memory for pure metadata", () => {
    expect(
      sanitizeForMemoryCapture(
        `${json("Conversation info", '{"id":"chat-123"}')}\n${json("Sender", '{"name":"Alex"}')}`,
      ),
    ).toBe("");
  });
});
