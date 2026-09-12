// Line tests cover channel threading plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { linePlugin } from "./channel.js";
import { LineConfigSchema } from "./config-schema.js";

function resolveReplyToMode(line: Record<string, unknown>, accountId?: string) {
  const resolve = linePlugin.threading?.resolveReplyToMode;
  if (!resolve) {
    throw new Error("expected a LINE reply-to mode resolver");
  }
  return resolve({ cfg: { channels: { line } } as OpenClawConfig, accountId, chatType: "group" });
}

describe("line reply-to mode", () => {
  it("quotes nothing until an operator asks for it", () => {
    expect(resolveReplyToMode({ channelAccessToken: "token" })).toBe("off");
  });

  it("reads the channel-wide setting", () => {
    expect(resolveReplyToMode({ channelAccessToken: "token", replyToMode: "all" })).toBe("all");
  });

  it("lets an account override the channel-wide setting", () => {
    const line = {
      channelAccessToken: "token",
      replyToMode: "all",
      accounts: { work: { channelAccessToken: "work-token", replyToMode: "first" } },
    };

    expect(resolveReplyToMode(line, "work")).toBe("first");
    expect(resolveReplyToMode(line, "default")).toBe("all");
  });

  it("lets an account inherit the channel-wide setting", () => {
    const line = {
      channelAccessToken: "token",
      replyToMode: "first",
      accounts: { work: { channelAccessToken: "work-token" } },
    };

    expect(resolveReplyToMode(line, "work")).toBe("first");
  });

  it("accepts every mode LINE can act on", () => {
    for (const replyToMode of ["off", "first", "all"] as const) {
      expect(LineConfigSchema.safeParse({ replyToMode }).success).toBe(true);
      expect(resolveReplyToMode({ channelAccessToken: "token", replyToMode })).toBe(replyToMode);
    }
  });

  it('rejects "batched", which LINE has no batched turn to apply', () => {
    // Accepting it would leave an operator with a configured mode whose defining
    // behavior — answering a coalesced turn — never happens on LINE.
    expect(LineConfigSchema.safeParse({ replyToMode: "batched" }).success).toBe(false);
    expect(
      LineConfigSchema.safeParse({ accounts: { work: { replyToMode: "batched" } } }).success,
    ).toBe(false);
  });

  it("rejects a mode the shared reply policy does not define", () => {
    expect(LineConfigSchema.safeParse({ replyToMode: "quote" }).success).toBe(false);
    expect(
      LineConfigSchema.safeParse({ accounts: { work: { replyToMode: "quote" } } }).success,
    ).toBe(false);
  });
});
