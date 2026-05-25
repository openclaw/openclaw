import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveTelegramGroupAllowFromContext, resolveTelegramStreamMode } from "./bot/helpers.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";

describe("resolveTelegramStreamMode", () => {
  it("defaults to partial when telegram streaming is unset", () => {
    expect(resolveTelegramStreamMode(undefined)).toBe("partial");
    expect(resolveTelegramStreamMode({})).toBe("partial");
  });

  it("prefers explicit streaming boolean", () => {
    expect(resolveTelegramStreamMode({ streaming: true })).toBe("partial");
    expect(resolveTelegramStreamMode({ streaming: false })).toBe("off");
  });

  it("maps legacy streamMode values", () => {
    expect(resolveTelegramStreamMode({ streamMode: "off" })).toBe("off");
    expect(resolveTelegramStreamMode({ streamMode: "partial" })).toBe("partial");
    expect(resolveTelegramStreamMode({ streamMode: "block" })).toBe("block");
  });

  it("preserves unified progress mode on Telegram", () => {
    expect(resolveTelegramStreamMode({ streaming: "progress" })).toBe("progress");
  });
});

describe("resolveTelegramGroupAllowFromContext", () => {
  it("returns wildcard storeAllowFrom when store read fails with transient I/O error", async () => {
    const emfileError = Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
    const warnSpy = vi.spyOn(await import("openclaw/plugin-sdk/runtime-env"), "warn");

    const context = await resolveTelegramGroupAllowFromContext({
      chatId: 123,
      accountId: "default",
      readChannelAllowFromStore: async () => {
        throw emfileError;
      },
      resolveTelegramGroupConfig: () => ({}),
    });

    expect(context.storeAllowFrom).toEqual(["*"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("pairing-store read failed (EMFILE)"),
    );
    warnSpy.mockRestore();
  });

  it("returns actual store entries when store read succeeds", async () => {
    const context = await resolveTelegramGroupAllowFromContext({
      chatId: 123,
      accountId: "default",
      readChannelAllowFromStore: async () => ["111222333"],
      resolveTelegramGroupConfig: () => ({}),
    });

    expect(context.storeAllowFrom).toEqual(["111222333"]);
  });

  it("expands Telegram access groups before normalizing allowFrom entries", async () => {
    const cfg: OpenClawConfig = {
      accessGroups: {
        maintainers: {
          type: "message.senders",
          members: {
            telegram: ["12345"],
          },
        },
      },
    };

    const context = await resolveTelegramGroupAllowFromContext({
      cfg,
      chatId: -100123,
      accountId: "default",
      senderId: "12345",
      isGroup: true,
      groupAllowFrom: ["accessGroup:maintainers"],
      readChannelAllowFromStore: async () => [],
      resolveTelegramGroupConfig: () => ({}),
    });

    expect(context.effectiveGroupAllow.entries).toEqual(["12345"]);
    expect(context.effectiveGroupAllow.invalidEntries).toStrictEqual([]);
  });
});

describe("resolveTelegramDraftStreamingChunking", () => {
  it("uses smaller defaults than block streaming", () => {
    const chunking = resolveTelegramDraftStreamingChunking(undefined, "default");
    expect(chunking).toEqual({
      minChars: 200,
      maxChars: 800,
      breakPreference: "paragraph",
    });
  });

  it("clamps to telegram.textChunkLimit", () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: { allowFrom: ["*"], textChunkLimit: 150 } },
    };
    const chunking = resolveTelegramDraftStreamingChunking(cfg, "default");
    expect(chunking).toEqual({
      minChars: 150,
      maxChars: 150,
      breakPreference: "paragraph",
    });
  });

  it("supports per-account overrides", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          allowFrom: ["*"],
          accounts: {
            default: {
              allowFrom: ["*"],
              streaming: {
                preview: {
                  chunk: {
                    minChars: 10,
                    maxChars: 20,
                    breakPreference: "sentence",
                  },
                },
              },
            },
          },
        },
      },
    };
    const chunking = resolveTelegramDraftStreamingChunking(cfg, "default");
    expect(chunking).toEqual({
      minChars: 10,
      maxChars: 20,
      breakPreference: "sentence",
    });
  });
});
