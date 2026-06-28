import { describe, expect, it, vi } from "vitest";
import type { TelegramApiOverride } from "./send.js";
import { sendLocationTelegram, sendVenueTelegram } from "./send.js";

function makeMockApi(overrides: Partial<TelegramApiOverride> = {}): TelegramApiOverride {
  return {
    sendLocation: vi.fn().mockResolvedValue({ message_id: 42, chat: { id: "100" } }),
    sendVenue: vi.fn().mockResolvedValue({ message_id: 43, chat: { id: "100" } }),
    getChat: vi.fn().mockResolvedValue({ id: 100 }),
    ...overrides,
  };
}

const cfg = { channels: { telegram: { botToken: "test:token" } } } as never;

describe("sendLocationTelegram", () => {
  it("sends a location and returns messageId and chatId", async () => {
    const api = makeMockApi();
    const result = await sendLocationTelegram(
      "100",
      { latitude: 55.7558, longitude: 37.6173 },
      { cfg, api },
    );
    expect(result.messageId).toBe("42");
    expect(result.chatId).toBe("100");
    expect(api.sendLocation).toHaveBeenCalledWith(
      "100",
      55.7558,
      37.6173,
      expect.objectContaining({}),
    );
  });

  it("passes horizontalAccuracy when provided", async () => {
    const api = makeMockApi();
    await sendLocationTelegram(
      "100",
      { latitude: 55.7558, longitude: 37.6173, horizontalAccuracy: 50 },
      { cfg, api },
    );
    expect(api.sendLocation).toHaveBeenCalledWith(
      "100",
      55.7558,
      37.6173,
      expect.objectContaining({ horizontal_accuracy: 50 }),
    );
  });

  it("throws when latitude is out of range", async () => {
    const api = makeMockApi();
    await expect(
      sendLocationTelegram("100", { latitude: 200, longitude: 37 }, { cfg, api }),
    ).rejects.toThrow("latitude");
  });

  it("throws when longitude is out of range", async () => {
    const api = makeMockApi();
    await expect(
      sendLocationTelegram("100", { latitude: 55, longitude: 200 }, { cfg, api }),
    ).rejects.toThrow("longitude");
  });
});

describe("sendVenueTelegram", () => {
  it("sends a venue and returns messageId and chatId", async () => {
    const api = makeMockApi();
    const result = await sendVenueTelegram(
      "100",
      { latitude: 55.7558, longitude: 37.6173, title: "Red Square", address: "Moscow" },
      { cfg, api },
    );
    expect(result.messageId).toBe("43");
    expect(result.chatId).toBe("100");
    expect(api.sendVenue).toHaveBeenCalledWith(
      "100",
      55.7558,
      37.6173,
      "Red Square",
      "Moscow",
      expect.objectContaining({}),
    );
  });

  it("passes foursquareId and googlePlaceId when provided", async () => {
    const api = makeMockApi();
    await sendVenueTelegram(
      "100",
      {
        latitude: 55.7558,
        longitude: 37.6173,
        title: "Red Square",
        address: "Moscow",
        foursquareId: "4b058786f964a520c9f222e3",
        googlePlaceId: "ChIJybDUc_xKtUYRTM9XV8zWRD0",
      },
      { cfg, api },
    );
    expect(api.sendVenue).toHaveBeenCalledWith(
      "100",
      55.7558,
      37.6173,
      "Red Square",
      "Moscow",
      expect.objectContaining({
        foursquare_id: "4b058786f964a520c9f222e3",
        google_place_id: "ChIJybDUc_xKtUYRTM9XV8zWRD0",
      }),
    );
  });

  it("throws when title is empty", async () => {
    const api = makeMockApi();
    await expect(
      sendVenueTelegram(
        "100",
        { latitude: 55, longitude: 37, title: "  ", address: "Moscow" },
        { cfg, api },
      ),
    ).rejects.toThrow("title");
  });

  it("throws when address is empty", async () => {
    const api = makeMockApi();
    await expect(
      sendVenueTelegram(
        "100",
        { latitude: 55, longitude: 37, title: "Place", address: "" },
        { cfg, api },
      ),
    ).rejects.toThrow("address");
  });
});
