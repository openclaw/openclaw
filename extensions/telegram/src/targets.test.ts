// Telegram tests cover targets plugin behavior.
import { describe, expect, it } from "vitest";
import { normalizeTelegramMessagingTarget } from "./normalize.js";
import { installMaybePersistResolvedTelegramTargetTests } from "./target-writeback.test-shared.js";
import {
  normalizeTelegramChatId,
  normalizeTelegramLookupTarget,
  normalizeTelegramOutboundTarget,
  parseTelegramTarget,
} from "./targets.js";

describe("parseTelegramTarget", () => {
  it("rejects non-positive and unsafe channel Direct Messages topic ids", () => {
    for (const target of [
      "-1001234567890:direct-topic:0",
      "-1001234567890:direct-topic:9007199254740992",
    ]) {
      expect(parseTelegramTarget(target)).toEqual({ chatId: target, chatType: "unknown" });
    }
  });

  it("does not treat non-numeric suffix as topicId", () => {
    expect(parseTelegramTarget("-1001234567890:abc")).toEqual({
      chatId: "-1001234567890:abc",
      chatType: "unknown",
    });
  });

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

describe("normalizeTelegramChatId", () => {
  it("rejects username and t.me forms", () => {
    expect(normalizeTelegramChatId("telegram:https://t.me/MyChannel")).toBeUndefined();
    expect(normalizeTelegramChatId("tg:t.me/mychannel")).toBeUndefined();
    expect(normalizeTelegramChatId("@MyChannel")).toBeUndefined();
    expect(normalizeTelegramChatId("MyChannel")).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(normalizeTelegramChatId("  ")).toBeUndefined();
  });
});

describe("normalizeTelegramLookupTarget", () => {
  it("rejects invalid username forms", () => {
    expect(normalizeTelegramLookupTarget("@bad-handle")).toBeUndefined();
    expect(normalizeTelegramLookupTarget("bad-handle")).toBeUndefined();
    expect(normalizeTelegramLookupTarget("ab")).toBeUndefined();
  });
});

describe("telegram target normalization", () => {
  it("returns undefined for invalid telegram recipients", () => {
    expect(normalizeTelegramMessagingTarget("telegram:")).toBeUndefined();
    expect(normalizeTelegramMessagingTarget("   ")).toBeUndefined();
  });
});

installMaybePersistResolvedTelegramTargetTests();
