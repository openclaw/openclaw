import { MESSAGE_TOOL_DELIVERY_HINTS } from "openclaw/plugin-sdk/message-tool-delivery-hints";
import { describe, expect, test } from "vitest";
import { sanitizeForMemoryCapture } from "./memory-capture-sanitization.js";
import { shouldCapture } from "./memory-policy.js";

// Provenance marker OpenClaw appends to every injected inbound-context header.
// Detectors key on this marker, not label text. Keep byte-identical with
// src/auto-reply/reply/inbound-context-marker.ts (extensions cannot import core).
const CTX = "⟦openclaw:ctx⟧";
// Marks a context header line the way buildInboundUserContextPrefix does.
const ctxHeader = (label: string): string => `${label} ${CTX}`;

describe("memory capture sanitization", () => {
  test("sanitizeForMemoryCapture strips structurally marker-free channel envelope prefix", () => {
    // Mirror the looksLikeEnvelopeSludge marker-free coverage so the full
    // capture flow (sanitize -> shouldCapture) also handles the shape.
    expect(sanitizeForMemoryCapture("[telegram Alice] Alice: I prefer dark mode")).toBe(
      "I prefer dark mode",
    );
    expect(sanitizeForMemoryCapture("[telegram Alice id:123] Alice: I prefer dark mode")).toBe(
      "I prefer dark mode",
    );
    expect(sanitizeForMemoryCapture("[LINE user:U123] (sender): I prefer dark mode")).toBe(
      "I prefer dark mode",
    );
    expect(sanitizeForMemoryCapture("[discord #general user] user: ping")).toBe("ping");
    expect(sanitizeForMemoryCapture("[Google Chat Room] Room: I prefer dark mode")).toBe(
      "I prefer dark mode",
    );
    expect(sanitizeForMemoryCapture("[Nextcloud Talk Board] Board: I prefer dark mode")).toBe(
      "I prefer dark mode",
    );
    expect(sanitizeForMemoryCapture("[Teams General] General: I prefer dark mode")).toBe(
      "I prefer dark mode",
    );
    expect(sanitizeForMemoryCapture("[Signal Hill] is my favorite hike")).toBe(
      "[Signal Hill] is my favorite hike",
    );
    // Group-chat sender-prefix on the body is also stripped when the bracket is
    // recognized as an envelope.
    expect(sanitizeForMemoryCapture("[slack #general user] user: hello")).toBe("hello");
  });

  test("sanitizeForMemoryCapture leaves markdown links and unknown labels alone", () => {
    expect(sanitizeForMemoryCapture("[click here](https://example.com)")).toBe(
      "[click here](https://example.com)",
    );
    expect(sanitizeForMemoryCapture("[note] my thoughts")).toBe("[note] my thoughts");
  });

  test("sanitizeForMemoryCapture strips formatInboundEnvelope direct-message prefix", () => {
    expect(sanitizeForMemoryCapture("[Telegram Alice +5m] I prefer dark mode")).toBe(
      "I prefer dark mode",
    );
    expect(
      sanitizeForMemoryCapture("[Telegram Alice +5m Mon 2026-05-17 14:30 EDT] I prefer dark mode"),
    ).toBe("I prefer dark mode");
  });

  test("sanitizeForMemoryCapture strips group-chat envelope prefix AND sender label", () => {
    expect(
      sanitizeForMemoryCapture(
        "[Telegram Group id:123 Alice +5m Mon 2026-05-17 14:30 EDT] Alice: I prefer dark mode",
      ),
    ).toBe("I prefer dark mode");
  });

  test("sanitizeForMemoryCapture strips sender label from real room-label envelope shapes", () => {
    // Real group/channel callers pass the room/conversation as `from` and the
    // sender separately; the sender is not necessarily present in the header.
    expect(sanitizeForMemoryCapture("[Telegram group:123] Alice: I prefer dark mode")).toBe(
      "I prefer dark mode",
    );
    expect(sanitizeForMemoryCapture("[Slack #general] Alice: I prefer dark mode")).toBe(
      "I prefer dark mode",
    );
    expect(
      sanitizeForMemoryCapture(
        "[Discord OpenClaw #dev channel id:456 +5m] Alice: I prefer dark mode",
      ),
    ).toBe("I prefer dark mode");
    expect(sanitizeForMemoryCapture("[Telegram OpenClaw id:-100] Alice: I prefer dark mode")).toBe(
      "I prefer dark mode",
    );
    expect(sanitizeForMemoryCapture("[Signal Signal Group id:123] Bob (42): ping")).toBe("ping");
  });

  test("sanitizeForMemoryCapture preserves user labels in generic room envelopes", () => {
    expect(
      sanitizeForMemoryCapture(
        "[Nextcloud Talk room:ops Mon 2026-05-17 14:30 UTC] TODO: keep this",
      ),
    ).toBe("TODO: keep this");
    expect(sanitizeForMemoryCapture("[Slack #general] TODO: keep this")).toBe("TODO: keep this");
    expect(sanitizeForMemoryCapture("[WhatsApp Family Chat +5m] Alice: hello")).toBe(
      "Alice: hello",
    );
    expect(sanitizeForMemoryCapture("[Telegram Alice +5m] Bob (42): I prefer dark mode")).toBe(
      "Bob (42): I prefer dark mode",
    );
  });

  test("sanitizeForMemoryCapture leaves text with no envelope prefix alone", () => {
    // No bracket envelope: the `Name: ` sender-stripper must NOT fire on
    // user-typed text that happens to look like `Name: body`.
    expect(sanitizeForMemoryCapture("Alice: I prefer dark mode")).toBe("Alice: I prefer dark mode");
  });

  test("sanitizeForMemoryCapture preserves DM body that starts with `TODO:` / `FIXME:`", () => {
    // Direct-message envelope: per the formatter contract there is no sender
    // prefix on the body. A user-typed `TODO: ...` or `FIXME: ...` must not
    // be truncated to `...`. The leading label does not match any token in
    // the envelope header, so the gated strip leaves it alone.
    expect(sanitizeForMemoryCapture("[telegram alice +5m] TODO: fix this")).toBe("TODO: fix this");
    expect(sanitizeForMemoryCapture("[Telegram Alice +5m] FIXME: clean up sanitizer")).toBe(
      "FIXME: clean up sanitizer",
    );
  });

  test("sanitizeForMemoryCapture preserves group body whose `Name: ` does not match envelope", () => {
    // Group envelope `[discord alice]` with body `Bob: hello` (Alice is
    // quoting Bob). `Bob` is not a token in the envelope header, so the
    // formatter could not have emitted it; the gated strip leaves it alone.
    expect(sanitizeForMemoryCapture("[discord alice +5m] Bob: hello there")).toBe(
      "Bob: hello there",
    );
  });

  test("sanitizeForMemoryCapture strips `(self):` body prefix from direct fromMe envelope", () => {
    // Direct chat + fromMe contract: body is `(self): <text>`. The literal
    // `(self)` sentinel is always safe to strip after an envelope bracket.
    expect(sanitizeForMemoryCapture("[telegram alice] (self): typed this")).toBe("typed this");
    expect(sanitizeForMemoryCapture("[Telegram Alice +5m] (self): note to self")).toBe(
      "note to self",
    );
  });

  test("shouldCapture rejects formatInboundEnvelope-prefixed messages", () => {
    // The agent_end hook still receives envelope-prefixed user content, so the
    // capture gate must reject these without relying on prior sanitize.
    expect(shouldCapture("[Telegram Alice +5m] I prefer dark mode")).toBe(false);
    expect(
      shouldCapture(
        "[Telegram Group id:123 Alice +5m Mon 2026-05-17 14:30 EDT] Alice: I prefer dark mode",
      ),
    ).toBe(false);
  });

  test("sanitize-then-shouldCapture preserves clean body from envelope-wrapped input", () => {
    // End-to-end shape of the real auto-capture flow: sanitize first, then
    // shouldCapture decides on the body-only text. A genuine memory like
    // "I prefer dark mode" wrapped in envelope metadata must survive the
    // sanitize step as bare body and pass the gate.
    const wrapped = "[Telegram Alice +5m] I prefer dark mode";
    const sanitized = sanitizeForMemoryCapture(wrapped);
    expect(sanitized).toBe("I prefer dark mode");
    expect(shouldCapture(sanitized)).toBe(true);
  });

  test("shouldCapture rejects envelope sludge", () => {
    expect(
      shouldCapture(
        `${ctxHeader("Conversation info:")}\n\`\`\`json\n{"id":"123"}\n\`\`\`\nI always prefer dark mode`,
      ),
    ).toBe(false);
  });

  test("sanitizeForMemoryCapture strips timestamp prefix", () => {
    expect(sanitizeForMemoryCapture("[Mon 2026-04-14 12:34 EDT] I prefer dark mode")).toBe(
      "I prefer dark mode",
    );
  });

  test("sanitizeForMemoryCapture strips inbound metadata blocks", () => {
    const input = [
      ctxHeader("Sender:"),
      "```json",
      '{"name": "Alex"}',
      "```",
      "",
      "I always prefer verbose output",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("I always prefer verbose output");
  });

  test("sanitizeForMemoryCapture strips known current inbound metadata blocks", () => {
    const locationInput = [
      ctxHeader("Location:"),
      "```json",
      '{"lat": 48.2, "lng": 16.3}',
      "```",
      "",
      "I always prefer dark mode",
    ].join("\n");
    expect(sanitizeForMemoryCapture(locationInput)).toBe("I always prefer dark mode");

    const replyChainInput = [
      ctxHeader("Reply chain of current user message (nearest first):"),
      "```json",
      '[{"body":"quoted context"}]',
      "```",
      "",
      "I always prefer concise replies",
    ].join("\n");
    expect(sanitizeForMemoryCapture(replyChainInput)).toBe("I always prefer concise replies");
  });

  test("sanitizeForMemoryCapture drops presentation-only media-note lines", () => {
    const input = [
      "[media attached: /tmp/photo.jpg (image/jpeg)]",
      "Check this and remember it",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("Check this and remember it");

    const bracketedFilename =
      "[media attached: /tmp/foo] I always prefer dark-mode.png (image/png)]";
    expect(sanitizeForMemoryCapture(bracketedFilename)).toBe("");
    expect(sanitizeForMemoryCapture(`${bracketedFilename}\nI prefer concise captions`)).toBe(
      "I prefer concise captions",
    );
  });

  test("sanitizeForMemoryCapture preserves captions after inline legacy media text", () => {
    const input = "[media attached: stale.png] I always prefer dark mode";
    expect(sanitizeForMemoryCapture(input)).toBe(input);
    expect(shouldCapture(input)).toBe(true);

    const prose = "[media attached files are how I always prefer to receive reports]";
    expect(sanitizeForMemoryCapture(prose)).toBe(prose);
    expect(shouldCapture(prose)).toBe(true);

    const numberedCaption = "[media attached 1/1: stale.png] I always prefer dark mode";
    expect(sanitizeForMemoryCapture(numberedCaption)).toBe(numberedCaption);
  });

  test("sanitizeForMemoryCapture strips active_memory_plugin blocks", () => {
    const input =
      "<active_memory_plugin>some plugin data</active_memory_plugin>\nI prefer concise replies";
    expect(sanitizeForMemoryCapture(input)).toBe("I prefer concise replies");
  });

  test("sanitizeForMemoryCapture strips active memory prefix before user text", () => {
    const input = [
      "Context:",
      "<active_memory_plugin>recall context</active_memory_plugin>",
      "",
      "I prefer dark mode",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("I prefer dark mode");
  });

  test("sanitizeForMemoryCapture strips marked context header and trailing content", () => {
    const input = `I prefer dark mode\n${ctxHeader("Context:")}\nsome trailing metadata`;
    expect(sanitizeForMemoryCapture(input)).toBe("I prefer dark mode");
  });

  test("sanitizeForMemoryCapture preserves a bare context header and trailing content", () => {
    const input = "I prefer dark mode\nContext:\nsome user-authored text";
    expect(sanitizeForMemoryCapture(input)).toBe(input);
  });

  test("sanitizeForMemoryCapture does not strip a context label mid-line", () => {
    const input = "The user mentioned Context: in their question about security";
    expect(sanitizeForMemoryCapture(input)).toBe(
      "The user mentioned Context: in their question about security",
    );
  });

  test("sanitizeForMemoryCapture preserves a near-miss context header with trailing text", () => {
    const input = "Context: I prefer dark mode at work\nplease remember that";
    expect(sanitizeForMemoryCapture(input)).toBe(input);
  });

  test("sanitizeForMemoryCapture pre-truncates very large inputs", () => {
    const padding = "x".repeat(11_000);
    const input = `${padding}\nI always prefer dark mode`;
    const result = sanitizeForMemoryCapture(input);
    expect(result).not.toContain("I always prefer dark mode");
    expect(result.length).toBeLessThanOrEqual(10_000);
  });

  test("sanitizeForMemoryCapture returns empty string for pure metadata", () => {
    const input = [
      ctxHeader("Conversation info:"),
      "```json",
      '{"id": "chat-123", "title": "Test"}',
      "```",
      ctxHeader("Sender:"),
      "```json",
      '{"name": "Alex"}',
      "```",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("");
  });

  test("sanitizeForMemoryCapture handles combined contamination", () => {
    const input = [
      `[Sun 2026-04-13 09:15 EDT] ${ctxHeader("Conversation info:")}`,
      "```json",
      '{"id": "chat-456"}',
      "```",
      ctxHeader("Sender:"),
      "```json",
      '{"name": "Alex"}',
      "```",
      "",
      "[media attached: /tmp/screenshot.png (image/png)]",
      "I always prefer TypeScript over JavaScript",
      "",
      "<active_memory_plugin>recall context</active_memory_plugin>",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("I always prefer TypeScript over JavaScript");
  });

  test("sanitizeForMemoryCapture truncates chat-history plain-text body so MEMORY_TRIGGER words inside are not captured", () => {
    // The "Chat history since last reply" sentinel is followed by a plain-text
    // transcript rather than a ```json``` fence.  The body must be truncated so
    // that MEMORY_TRIGGER phrases inside quoted bot replies are never vectorized
    // as long-term memories.
    const input = [
      "I always prefer dark mode",
      ctxHeader("Chat history since last reply:"),
      "User: what do you recommend?",
      "Bot: I always recommend TypeScript for large projects",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("I always prefer dark mode");
  });

  test("sanitizeForMemoryCapture drops leading plain-text metadata bodies without a current boundary", () => {
    const input = [
      ctxHeader("Chat history since last reply:"),
      "User: what do you recommend?",
      "Bot: I always recommend TypeScript for large projects",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("");
  });

  test("sanitizeForMemoryCapture keeps current marker content after leading plain-text metadata", () => {
    const input = [
      ctxHeader("Chat history since last reply:"),
      "[Telegram Bob] Bob: I always recommend historical wrong value",
      "",
      "[Current message - respond to this]",
      "[Telegram group:-100] obviyus: I prefer dark mode",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("I prefer dark mode");
  });

  test("sanitizeForMemoryCapture truncates thread-starter plain-text body", () => {
    // Same fix for "Thread starter:" which also carries
    // a plain-text body instead of a JSON code fence.
    const input = [
      "I always use ESLint in every project",
      ctxHeader("Thread starter:"),
      "Original message: I always want verbose logging enabled",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("I always use ESLint in every project");
  });

  test("sanitizeForMemoryCapture truncates at earliest sentinel across multiple inbound-meta blocks", () => {
    // Regression guard for the per-sentinel loop ordering bug: when a body
    // contains two different sentinels the sanitizer must truncate at the
    // EARLIEST position, regardless of INBOUND_META_SENTINELS declaration
    // order. Here `Chat history since last reply` appears BEFORE
    // `Conversation info`; the iteration-order-dependent code would
    // truncate at `Conversation info` (declared first) and preserve the
    // plain-text history that followed `Chat history`.
    const input = [
      "I always prefer dark mode",
      ctxHeader("Chat history since last reply:"),
      "User: hi",
      "Bot: I always say hello back",
      ctxHeader("Conversation info:"),
      "irrelevant trailing metadata",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("I always prefer dark mode");
  });

  test("sanitizeForMemoryCapture strips current context before envelope prefixes", () => {
    const input = [
      ctxHeader("Conversation info:"),
      "```json",
      '{"channel":"slack"}',
      "```",
      "",
      ctxHeader("Conversation context (chronological, selected for current message):"),
      "[Slack #general Alice] Alice: I always prefer dark mode",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("I always prefer dark mode");
  });

  test("sanitizeForMemoryCapture does not capture stale chronological history envelopes", () => {
    const input = [
      ctxHeader("Conversation context (chronological, selected for current message):"),
      "Bob: [telegram bob] I always prefer stale context",
      "[Telegram Alice] I always prefer dark mode",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("");
  });

  test("sanitizeForMemoryCapture preserves prompt after plain chronological context", () => {
    const input = [
      ctxHeader("Conversation context (chronological, selected for current message):"),
      "#35674 Other: stale context",
      "",
      "I always prefer dark mode",
    ].join("\n");
    const sanitized = sanitizeForMemoryCapture(input);
    expect(sanitized).toBe("I always prefer dark mode");
    expect(shouldCapture(sanitized)).toBe(true);
  });

  test("sanitizeForMemoryCapture keeps inline envelope after current-message prefix", () => {
    const input = [
      ctxHeader("Conversation context (chronological, selected for current message):"),
      "#34974 obviyus: [Telegram group:-100] obviyus: I prefer dark mode",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("I prefer dark mode");
  });

  test("sanitizeForMemoryCapture strips envelopes after JSON-only metadata", () => {
    const input = [
      ctxHeader("Conversation info:"),
      "```json",
      '{"channel":"telegram"}',
      "```",
      "",
      "[Telegram Alice] I prefer dark mode",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("I prefer dark mode");
  });

  test("sanitizeForMemoryCapture preserves an unknown structured-context label as user content", () => {
    // An arbitrary `<label>:` + fence whose JSON carries no envelope key is the
    // user's own text, not an OpenClaw injection, so it survives capture intact.
    const input = [
      `${"Custom ".repeat(30)}label:`,
      "```json",
      '{"note":"I always prefer stale metadata"}',
      "```",
      "",
      "I prefer dark mode",
    ].join("\n");
    const result = sanitizeForMemoryCapture(input);
    expect(result).toContain("I prefer dark mode");
    expect(result).toContain(`${"Custom ".repeat(30)}label:`);
  });

  test("sanitizeForMemoryCapture strips current message reply context before envelopes", () => {
    const input = [
      ctxHeader("Conversation info:"),
      "```json",
      '{"channel":"telegram"}',
      "```",
      "",
      "Current message:",
      '[Replying to: "quoted status body"]',
      "#34974 obviyus: [Telegram group:-100] obviyus: I prefer dark mode",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("I prefer dark mode");
  });

  test("sanitizeForMemoryCapture strips current message reply context without envelopes", () => {
    const input = [
      "Current message:",
      '[Replying to: "quoted status body"]',
      "#34974 obviyus: I prefer dark mode",
    ].join("\n");
    const sanitized = sanitizeForMemoryCapture(input);
    expect(sanitized).toBe("I prefer dark mode");
    expect(shouldCapture(sanitized)).toBe(true);
  });

  test("sanitizeForMemoryCapture strips message-tool delivery hints before envelopes", () => {
    for (const deliveryHint of MESSAGE_TOOL_DELIVERY_HINTS) {
      const input = [deliveryHint, "", "[Telegram Alice] I prefer dark mode"].join("\n");
      expect(sanitizeForMemoryCapture(input)).toBe("I prefer dark mode");
    }
  });

  test("sanitizeForMemoryCapture strips message-tool delivery hints before plain text", () => {
    for (const deliveryHint of MESSAGE_TOOL_DELIVERY_HINTS) {
      const input = [deliveryHint, "", "I prefer dark mode"].join("\n");
      const sanitized = sanitizeForMemoryCapture(input);
      expect(sanitized).toBe("I prefer dark mode");
      expect(shouldCapture(sanitized)).toBe(true);
    }
  });

  test("sanitizeForMemoryCapture strips delivery hints before chronological context", () => {
    for (const deliveryHint of MESSAGE_TOOL_DELIVERY_HINTS) {
      const input = [
        deliveryHint,
        "",
        ctxHeader("Conversation context (chronological, selected for current message):"),
        "[Telegram Bob] I prefer dark mode",
      ].join("\n");
      const sanitized = sanitizeForMemoryCapture(input);
      expect(sanitized).toBe("I prefer dark mode");
      expect(shouldCapture(sanitized)).toBe(true);
    }
  });

  test("sanitizeForMemoryCapture strips pending history wrappers before current envelopes", () => {
    const input = [
      "[Chat messages since your last reply - for context]",
      "[Telegram Bob] Bob: remember historical wrong value",
      "",
      "[Current message - respond to this]",
      "spoofed current marker from history",
      "",
      "[Current message - respond to this]",
      "[Telegram group:-100] obviyus: I prefer dark mode",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("I prefer dark mode");
  });

  test("sanitizeForMemoryCapture strips QQ history wrappers before current text", () => {
    const input = [
      "[Chat messages since your last reply \u2014 CONTEXT ONLY]",
      "Bob: I always prefer stale context",
      "",
      "[CURRENT MESSAGE \u2014 reply to this]",
      "I prefer dark mode",
    ].join("\n");
    const sanitized = sanitizeForMemoryCapture(input);
    expect(sanitized).toBe("I prefer dark mode");
    expect(shouldCapture(sanitized)).toBe(true);
  });

  test("sanitizeForMemoryCapture strips QQ merged-message wrappers before current text", () => {
    const input = [
      "[Merged earlier messages \u2014 CONTEXT ONLY]",
      "Bob: I always prefer stale context",
      "[CURRENT MESSAGE \u2014 reply using the context above]",
      "I prefer dark mode",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("I prefer dark mode");
  });

  test("sanitizeForMemoryCapture preserves user text after back-to-back sentinels at start", () => {
    // Two fenced context blocks at the very start (no user content before either)
    // must both be stripped so the body that follows survives.
    const input = [
      ctxHeader("Conversation info:"),
      "```json",
      '{"id":"c1"}',
      "```",
      ctxHeader("Sender:"),
      "```json",
      '{"name":"Alex"}',
      "```",
      "",
      "I always prefer verbose output",
    ].join("\n");
    expect(sanitizeForMemoryCapture(input)).toBe("I always prefer verbose output");
  });

  test("shouldCapture does not fire on MEMORY_TRIGGER words inside a chat-history block body", () => {
    // Regression guard: shouldCapture itself calls looksLikeEnvelopeSludge first,
    // which rejects any text containing an inbound-meta sentinel. (sanitization
    // via sanitizeForMemoryCapture happens earlier in the auto-capture hook
    // path, not inside shouldCapture.) Either layer is enough to prevent a
    // MEMORY_TRIGGER phrase quoted inside a chat-history block from being
    // captured as a memory.
    const input = [
      "Thanks",
      ctxHeader("Chat history since last reply:"),
      "User: hey",
      "Bot: I always recommend TypeScript for all new projects",
    ].join("\n");
    expect(shouldCapture(input)).toBe(false);
  });
});
