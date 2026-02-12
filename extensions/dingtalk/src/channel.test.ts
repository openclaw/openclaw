import { describe, expect, it } from "vitest";
import { dingtalkPlugin } from "./channel.js";
import { DINGTALK_CHANNEL_ID, DINGTALK_LEGACY_CHANNEL_ID } from "./config-schema.js";

describe("dingtalkPlugin.reload", () => {
  it("watches both canonical and legacy config prefixes", () => {
    expect(dingtalkPlugin.reload?.configPrefixes).toEqual([
      `channels.${DINGTALK_CHANNEL_ID}`,
      `channels.${DINGTALK_LEGACY_CHANNEL_ID}`,
    ]);
  });
});
