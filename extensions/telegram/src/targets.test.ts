// Telegram tests cover targets plugin behavior.
import { describe, expect, it } from "vitest";
import { normalizeTelegramMessagingTarget } from "./normalize.js";
import { installMaybePersistResolvedTelegramTargetTests } from "./target-writeback.test-shared.js";
import {
  hasRejectedTelegramTopic,
  normalizeTelegramOutboundTarget,
  parseTelegramTarget,
} from "./targets.js";

describe("parseTelegramTarget", () => {
  it("does not route unsafe topic suffixes", () => {
    expect(parseTelegramTarget("-1001234567890:9007199254740992")).toEqual({
      chatId: "-1001234567890:9007199254740992",
      chatType: "unknown",
    });
    expect(parseTelegramTarget("-1001234567890:topic:9007199254740992")).toEqual({
      chatId: "-1001234567890:topic:9007199254740992",
      chatType: "unknown",
    });
  });
});

describe("hasRejectedTelegramTopic", () => {
  it("flags a rejected topic only when the base target is valid", () => {
    for (const target of [
      "-1001234567890:topic:0",
      "-1001234567890:0",
      "telegram:group:-1001234567890:topic:0",
      "@fixture:topic:0",
    ]) {
      expect(hasRejectedTelegramTopic(target), target).toBe(true);
    }
    for (const target of [
      "-1001234567890",
      "-1001234567890:topic:7",
      "-1001234567890:abc",
      "garbage:extra:0",
    ]) {
      expect(hasRejectedTelegramTopic(target), target).toBe(false);
    }
  });
});

describe("normalizeTelegramOutboundTarget", () => {
  it("normalizes legacy durable group retry targets with topic suffixes", () => {
    expect(normalizeTelegramOutboundTarget("group:-1001234567890:topic:77")).toBe(
      "-1001234567890:topic:77",
    );
    expect(normalizeTelegramOutboundTarget("group:-1001234567890:77")).toBe("-1001234567890:77");
    expect(normalizeTelegramOutboundTarget("group:-1001234567890:direct-topic:77")).toBe(
      "-1001234567890:direct-topic:77",
    );
  });

  it("keeps already-valid numeric and non-numeric targets on the send path", () => {
    expect(normalizeTelegramOutboundTarget("-1001234567890")).toBe("-1001234567890");
    expect(normalizeTelegramOutboundTarget("group:not-a-number")).toBe("group:not-a-number");
    expect(normalizeTelegramOutboundTarget("@mychannel")).toBe("@mychannel");
  });
});

describe("telegram target normalization", () => {
  it("returns undefined for invalid telegram recipients", () => {
    expect(normalizeTelegramMessagingTarget("telegram:")).toBeUndefined();
    expect(normalizeTelegramMessagingTarget("   ")).toBeUndefined();
  });
});

installMaybePersistResolvedTelegramTargetTests();
