/**
 * CardKit 模块单元测试
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { createCardEntity, updateCardEntity, buildCardData } from "./cardkit";
import { createFeishuClient } from "./client";

// Mock dependencies
vi.mock("./client", () => ({
  createFeishuClient: vi.fn(),
}));

vi.mock("./accounts", () => ({
  resolveFeishuAccount: () => ({
    accountId: "default",
    configured: true,
    appId: "test_app_id",
    appSecret: "test_app_secret",
    domain: "feishu",
    config: {},
  }),
}));

describe("CardKit", () => {
  const mockClient = {
    cardkit: {
      v1: {
        card: {
          create: vi.fn(),
          update: vi.fn(),
        },
      },
    },
  };

  const mockCfg = {
    channels: {
      feishu: {
        appId: "test_app_id",
        appSecret: "test_app_secret",
      },
    },
  } as unknown as ClawdbotConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createFeishuClient).mockReturnValue(mockClient as any);
  });

  describe("buildCardData", () => {
    it("should build card data with default config", () => {
      const result = buildCardData({ content: "test content" });

      expect(result.schema).toBe("2.0");
      expect(result.config?.update_multi).toBe(true);
      expect(result.config?.wide_screen_mode).toBe(true);
      expect(result.body.elements[0].tag).toBe("markdown");
      expect(result.body.elements[0].content).toBe("test content");
    });

    it("should build card data with title", () => {
      const result = buildCardData({ content: "test", title: "My Title" });

      expect(result.header?.title?.content).toBe("My Title");
      expect(result.header?.title?.tag).toBe("plain_text");
    });

    it("should build card data with streaming mode", () => {
      const result = buildCardData({ content: "test", streaming: true });

      expect(result.config?.streaming_mode).toBe(true);
    });

    it("should build card data without streaming mode", () => {
      const result = buildCardData({ content: "test", streaming: false });

      expect(result.config?.streaming_mode).toBeUndefined();
    });
  });

  describe("createCardEntity", () => {
    it("should create card entity successfully", async () => {
      mockClient.cardkit.v1.card.create.mockResolvedValue({
        code: 0,
        data: { card_id: "test_card_id" },
      });

      const result = await createCardEntity({
        cfg: mockCfg,
        content: "test content",
      });

      expect(result).toBe("test_card_id");
      expect(mockClient.cardkit.v1.card.create).toHaveBeenCalledWith({
        request_body: {
          type: "card_json",
          data: expect.any(String),
        },
      });
    });

    it("should return null when API fails", async () => {
      mockClient.cardkit.v1.card.create.mockResolvedValue({
        code: 500,
        msg: "Internal error",
      });

      const result = await createCardEntity({
        cfg: mockCfg,
        content: "test content",
      });

      expect(result).toBeNull();
    });

    it("should return null when API throws error", async () => {
      mockClient.cardkit.v1.card.create.mockRejectedValue(new Error("Network error"));

      const result = await createCardEntity({
        cfg: mockCfg,
        content: "test content",
      });

      expect(result).toBeNull();
    });

    it("should use custom title", async () => {
      mockClient.cardkit.v1.card.create.mockResolvedValue({
        code: 0,
        data: { card_id: "test_card_id" },
      });

      await createCardEntity({
        cfg: mockCfg,
        content: "test",
        title: "Custom Title",
      });

      expect(mockClient.cardkit.v1.card.create).toHaveBeenCalledTimes(1);
      const callArgs = mockClient.cardkit.v1.card.create.mock.calls[0][0];
      expect(callArgs).toBeDefined();
      expect(callArgs.request_body).toBeDefined();
      
      const cardData = JSON.parse(callArgs.request_body.data);
      expect(cardData.header).toBeDefined();
      expect(cardData.header.title.content).toBe("Custom Title");
    });
  });

  describe("updateCardEntity", () => {
    it("should update card entity successfully", async () => {
      mockClient.cardkit.v1.card.update.mockResolvedValue({
        code: 0,
      });

      const result = await updateCardEntity({
        cfg: mockCfg,
        cardId: "test_card_id",
        content: "updated content",
        sequence: 1,
      });

      expect(result).toBe(true);
      expect(mockClient.cardkit.v1.card.update).toHaveBeenCalledWith({
        path: { card_id: "test_card_id" },
        request_body: {
          card: {
            type: "card_json",
            data: expect.any(String),
          },
          sequence: 1,
        },
      });
    });

    it("should return false when API fails", async () => {
      mockClient.cardkit.v1.card.update.mockResolvedValue({
        code: 500,
        msg: "Internal error",
      });

      const result = await updateCardEntity({
        cfg: mockCfg,
        cardId: "test_card_id",
        content: "updated content",
        sequence: 1,
      });

      expect(result).toBe(false);
    });

    it("should return false when API throws error", async () => {
      mockClient.cardkit.v1.card.update.mockRejectedValue(new Error("Network error"));

      const result = await updateCardEntity({
        cfg: mockCfg,
        cardId: "test_card_id",
        content: "updated content",
        sequence: 1,
      });

      expect(result).toBe(false);
    });

    it("should increment sequence correctly", async () => {
      mockClient.cardkit.v1.card.update.mockResolvedValue({ code: 0 });

      await updateCardEntity({
        cfg: mockCfg,
        cardId: "test_card_id",
        content: "content 1",
        sequence: 1,
      });

      await updateCardEntity({
        cfg: mockCfg,
        cardId: "test_card_id",
        content: "content 2",
        sequence: 2,
      });

      const calls = mockClient.cardkit.v1.card.update.mock.calls;
      expect(calls[0][0].request_body.sequence).toBe(1);
      expect(calls[1][0].request_body.sequence).toBe(2);
    });
  });
});
