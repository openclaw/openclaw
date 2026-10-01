import { describe, expect, it } from "vitest";
import { linePlugin } from "./channel.js";
import { LineConfigSchema } from "./config-schema.js";

describe("LINE reply-to mode", () => {
  it("accepts configured modes and lets an account override the channel", () => {
    const cfg = {
      channels: {
        line: LineConfigSchema.parse({
          channelAccessToken: "token",
          replyToMode: "all",
          accounts: { work: { channelAccessToken: "work-token", replyToMode: "first" } },
        }),
      },
    };
    const resolve = linePlugin.threading!.resolveReplyToMode!;
    expect(resolve({ cfg, accountId: "work", chatType: "group" })).toBe("first");
    expect(resolve({ cfg, chatType: "group" })).toBe("all");
  });
});
