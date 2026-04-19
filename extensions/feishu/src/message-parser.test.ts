/**
 * Tests for the extracted message-parser module.
 *
 * These tests verify that parseFeishuMessageEvent works identically when
 * imported from the new message-parser.ts module (used by monitor.account.ts
 * and sequential-key.ts) versus the original bot.ts re-export.
 *
 * This extraction was made to fix a circular module initialization issue
 * that caused ReferenceError in Feishu group chat mention handling.
 * See: https://github.com/openclaw/openclaw/issues/64783
 */
import { describe, it, expect } from "vitest";
import type { FeishuMessageEvent } from "./event-types.js";
import { parseFeishuMessageEvent } from "./message-parser.js";
import { parseFeishuMessageEvent as parseFromBot } from "./bot.js";

// ---- helpers ----

const BOT_OPEN_ID = "ou_bot_123";

function makeEvent(
  chatType: "p2p" | "group" | "private",
  mentions?: Array<{ key: string; name: string; id: { open_id?: string } }>,
  text = "hello",
): FeishuMessageEvent {
  return {
    sender: {
      sender_id: { user_id: "u1", open_id: "ou_sender" },
      sender_type: "user",
    },
    message: {
      message_id: "msg_1",
      chat_id: "oc_chat1",
      chat_type: chatType,
      message_type: "text",
      content: JSON.stringify({ text }),
      mentions,
    },
  } as FeishuMessageEvent;
}

// ---- parseFeishuMessageEvent from message-parser.ts ----

describe("message-parser: parseFeishuMessageEvent", () => {
  it("parses a basic text message in p2p chat", () => {
    const event = makeEvent("p2p", undefined, "hello world");
    const ctx = parseFeishuMessageEvent(event, BOT_OPEN_ID);
    expect(ctx.chatId).toBe("oc_chat1");
    expect(ctx.messageId).toBe("msg_1");
    expect(ctx.content).toBe("hello world");
    expect(ctx.chatType).toBe("p2p");
    expect(ctx.mentionedBot).toBe(false);
    expect(ctx.hasAnyMention).toBe(false);
    expect(ctx.mentionTargets).toBeUndefined();
  });

  it("detects bot mention in group chat", () => {
    const event = makeEvent("group", [
      { key: "@_user_1", name: "Bot", id: { open_id: BOT_OPEN_ID } },
    ]);
    const ctx = parseFeishuMessageEvent(event, BOT_OPEN_ID);
    expect(ctx.mentionedBot).toBe(true);
    expect(ctx.hasAnyMention).toBe(true);
  });

  it("does not set mentionedBot when a different user is mentioned", () => {
    const event = makeEvent("group", [
      { key: "@_user_1", name: "Other User", id: { open_id: "ou_other_user" } },
    ]);
    const ctx = parseFeishuMessageEvent(event, BOT_OPEN_ID);
    expect(ctx.mentionedBot).toBe(false);
    expect(ctx.hasAnyMention).toBe(true);
  });

  it("detects mention forward request (bot + other user mentioned in group)", () => {
    const event = makeEvent("group", [
      { key: "@_user_1", name: "Bot", id: { open_id: BOT_OPEN_ID } },
      { key: "@_user_2", name: "Target User", id: { open_id: "ou_target" } },
    ]);
    const ctx = parseFeishuMessageEvent(event, BOT_OPEN_ID);
    expect(ctx.mentionedBot).toBe(true);
    expect(ctx.mentionTargets).toBeDefined();
    expect(ctx.mentionTargets).toHaveLength(1);
    expect(ctx.mentionTargets![0].openId).toBe("ou_target");
    expect(ctx.mentionTargets![0].name).toBe("Target User");
  });

  it("does not detect mention forward when only bot is mentioned in group", () => {
    const event = makeEvent("group", [
      { key: "@_user_1", name: "Bot", id: { open_id: BOT_OPEN_ID } },
    ]);
    const ctx = parseFeishuMessageEvent(event, BOT_OPEN_ID);
    expect(ctx.mentionTargets).toBeUndefined();
  });

  it("populates sender fields from event", () => {
    const event = makeEvent("p2p");
    const ctx = parseFeishuMessageEvent(event, BOT_OPEN_ID);
    expect(ctx.senderId).toBe("u1");
    expect(ctx.senderOpenId).toBe("ou_sender");
  });

  it("falls back to open_id when user_id is empty", () => {
    const event = makeEvent("p2p");
    event.sender.sender_id.user_id = "";
    const ctx = parseFeishuMessageEvent(event, BOT_OPEN_ID);
    expect(ctx.senderId).toBe("ou_sender");
    expect(ctx.senderOpenId).toBe("ou_sender");
  });

  it("handles message with root_id and parent_id", () => {
    const event = makeEvent("group");
    (event.message as Record<string, unknown>).root_id = "om_root_1";
    (event.message as Record<string, unknown>).parent_id = "om_parent_1";
    const ctx = parseFeishuMessageEvent(event, BOT_OPEN_ID);
    expect(ctx.rootId).toBe("om_root_1");
    expect(ctx.parentId).toBe("om_parent_1");
  });
});

// ---- backward compatibility: re-export from bot.ts ----

describe("message-parser: backward compatibility via bot.ts re-export", () => {
  it("bot.ts re-exports the same parseFeishuMessageEvent function", () => {
    // This confirms that code importing from bot.ts still gets the same
    // implementation, ensuring no regressions for existing consumers.
    expect(parseFromBot).toBe(parseFeishuMessageEvent);
  });

  it("produces identical output for a group mention event", () => {
    const event = makeEvent("group", [
      { key: "@_user_1", name: "Bot", id: { open_id: BOT_OPEN_ID } },
      { key: "@_user_2", name: "Target", id: { open_id: "ou_target" } },
    ]);
    const ctxDirect = parseFeishuMessageEvent(event, BOT_OPEN_ID);
    const ctxReExport = parseFromBot(event, BOT_OPEN_ID);
    expect(ctxDirect).toEqual(ctxReExport);
  });
});

// ---- module graph isolation ----

describe("message-parser: module isolation", () => {
  it("message-parser.ts does not import from bot.ts (circular break)", async () => {
    // This test verifies that the module-level fix is structurally sound:
    // message-parser.ts should only import from lightweight modules
    // (bot-content, mention, event-types, types) and NOT from bot.ts.
    //
    // We do a simple source-level check here rather than relying on the
    // bundler to catch the cycle, since the TDZ error only manifests in
    // the bundled output under specific initialization orderings.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const moduleDir = path.dirname(new URL(import.meta.url).pathname);
    const source = fs.readFileSync(path.join(moduleDir, "message-parser.ts"), "utf-8");

    // Must NOT contain imports from bot.ts (which would reintroduce the cycle)
    expect(source).not.toMatch(/from\s+["']\.\/bot\.js["']/);
    expect(source).not.toMatch(/from\s+["']\.\/bot["']/);

    // Must NOT contain imports from monitor.account.ts
    expect(source).not.toMatch(/from\s+["']\.\/monitor\.account/);

    // Must NOT contain imports from card-action.ts
    expect(source).not.toMatch(/from\s+["']\.\/card-action/);

    // Should import from lightweight modules only
    expect(source).toMatch(/from\s+["']\.\/bot-content\.js["']/);
    expect(source).toMatch(/from\s+["']\.\/mention\.js["']/);
    expect(source).toMatch(/from\s+["']\.\/event-types\.js["']/);
    expect(source).toMatch(/from\s+["']\.\/types\.js["']/);
  });

  it("monitor.account.ts does not statically import handleFeishuMessage from bot.ts", async () => {
    // Verify the lazy import pattern is in place — monitor.account.ts
    // should use dynamic import() for bot.ts, not a static import statement.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const moduleDir = path.dirname(new URL(import.meta.url).pathname);
    const source = fs.readFileSync(path.join(moduleDir, "monitor.account.ts"), "utf-8");

    // Static import of handleFeishuMessage from bot.ts should be gone
    expect(source).not.toMatch(/import\s*\{[^}]*handleFeishuMessage[^}]*\}\s*from\s*["']\.\/bot/);

    // Should use dynamic import pattern instead
    expect(source).toMatch(/import\(["']\.\/bot\.js["']\)/);

    // parseFeishuMessageEvent should come from message-parser, not bot
    expect(source).toMatch(/from\s+["']\.\/message-parser\.js["']/);
  });

  it("sequential-key.ts imports parseFeishuMessageEvent from message-parser, not bot", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const moduleDir = path.dirname(new URL(import.meta.url).pathname);
    const source = fs.readFileSync(path.join(moduleDir, "sequential-key.ts"), "utf-8");

    expect(source).toMatch(/from\s+["']\.\/message-parser\.js["']/);
    expect(source).not.toMatch(
      /import\s*\{[^}]*parseFeishuMessageEvent[^}]*\}\s*from\s*["']\.\/bot/,
    );
  });
});
