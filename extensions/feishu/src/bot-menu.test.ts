import { describe, expect, it } from "vitest";
import { resolveFeishuBotMenuCommand } from "./bot-menu.js";

describe("resolveFeishuBotMenuCommand", () => {
  it("maps built-in native command names to text commands", () => {
    expect(resolveFeishuBotMenuCommand("status")).toBe("/status");
    expect(resolveFeishuBotMenuCommand("export-session logs/out.html")).toBe(
      "/export-session logs/out.html",
    );
  });

  it("accepts explicit slash-command event keys", () => {
    expect(resolveFeishuBotMenuCommand("/model")).toBe("/model");
    expect(resolveFeishuBotMenuCommand("/export logs/out.html")).toBe(
      "/export-session logs/out.html",
    );
  });

  it("accepts prefixed command payloads", () => {
    expect(resolveFeishuBotMenuCommand("command:status")).toBe("/status");
    expect(resolveFeishuBotMenuCommand("cmd:model gmn/gpt-5.4")).toBe("/model gmn/gpt-5.4");
    expect(resolveFeishuBotMenuCommand("slash:/commands")).toBe("/commands");
  });

  it("returns null for unrelated event keys", () => {
    expect(resolveFeishuBotMenuCommand("quick-actions")).toBeNull();
    expect(resolveFeishuBotMenuCommand("custom-key")).toBeNull();
    expect(resolveFeishuBotMenuCommand("   ")).toBeNull();
  });
});
