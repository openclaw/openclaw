// Feishu tests cover bot-content helpers.
import { describe, expect, it } from "vitest";
import { normalizeFeishuCommandProbeBody, normalizeMentions } from "./bot-content.js";

describe("normalizeMentions", () => {
  it("preserves bot mention as @name when botStripId matches (#72504)", () => {
    const result = normalizeMentions(
      "@_bot_1 /model",
      [{ key: "@_bot_1", name: "MyBot", id: { open_id: "ou_bot" } }],
      "ou_bot",
    );
    expect(result).toBe("@MyBot /model");
  });

  it("preserves bot mention as @name for plain text in multi-bot groups (#72504)", () => {
    const result = normalizeMentions(
      "@_bot_1 hello world",
      [{ key: "@_bot_1", name: "MyBot", id: { open_id: "ou_bot" } }],
      "ou_bot",
    );
    expect(result).toBe("@MyBot hello world");
  });

  it("strips bot mention when botStripId does not match (non-bot mention)", () => {
    const result = normalizeMentions(
      "@_user_1 hi",
      [{ key: "@_user_1", name: "Alice", id: { open_id: "ou_alice" } }],
      "ou_bot",
    );
    expect(result).toBe('<at user_id="ou_alice">Alice</at> hi');
  });

  it("preserves bot mention name with special characters (#72504)", () => {
    const result = normalizeMentions(
      "@_bot_1 status",
      [{ key: "@_bot_1", name: "<Bot> Co", id: { open_id: "ou_bot" } }],
      "ou_bot",
    );
    expect(result).toBe("@&lt;Bot&gt; Co status");
  });
});

describe("normalizeFeishuCommandProbeBody (#72504)", () => {
  it("strips @name bot mention and preserves slash command", () => {
    // Bot mention kept as @name in ctx.content; probe body must strip it
    // so that command detection still sees the leading /.
    expect(normalizeFeishuCommandProbeBody("@MyBot /model")).toBe("/model");
  });

  it("strips @name mention and preserves text content", () => {
    expect(normalizeFeishuCommandProbeBody("@MyBot hello world")).toBe("hello world");
  });

  it("strips @name mention at start without a command", () => {
    expect(normalizeFeishuCommandProbeBody("@MyBot")).toBe("");
  });

  it("preserves slash command when preceded by @name mention", () => {
    expect(normalizeFeishuCommandProbeBody("@MyBot /help")).toBe("/help");
  });

  it("preserves slash command after @name mention with text", () => {
    expect(normalizeFeishuCommandProbeBody("@MyBot please /model")).toBe("please /model");
  });

  it("strips @name when mention is not at start", () => {
    expect(normalizeFeishuCommandProbeBody("hi @MyBot /status")).toBe("hi /status");
  });

  it("handles @mention with special characters in name", () => {
    expect(normalizeFeishuCommandProbeBody("@Bot-Name /version")).toBe("/version");
  });

  it("handles @mention without a following slash command", () => {
    expect(normalizeFeishuCommandProbeBody("@MyBot just checking in")).toBe("just checking in");
  });

  it("preserves !command after @name mention", () => {
    expect(normalizeFeishuCommandProbeBody("@MyBot !reset")).toBe("!reset");
  });

  it("handles multiple @mentions before a command", () => {
    expect(normalizeFeishuCommandProbeBody("@BotA @BotB /model")).toBe("/model");
  });

  it("preserves plain slash command when no @mention is present", () => {
    expect(normalizeFeishuCommandProbeBody("/model")).toBe("/model");
  });

  it("preserves plain text when no @mention or command is present", () => {
    expect(normalizeFeishuCommandProbeBody("hello world")).toBe("hello world");
  });

  it("strips <at> tags and preserves command", () => {
    expect(
      normalizeFeishuCommandProbeBody('<at user_id="ou_alice">Alice</at> /status'),
    ).toBe("/status");
  });

  it("handles empty input", () => {
    expect(normalizeFeishuCommandProbeBody("")).toBe("");
  });
});
