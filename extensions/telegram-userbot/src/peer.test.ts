import { describe, expect, it, vi } from "vitest";
import { UserbotPeerError } from "./errors.js";
import {
  parsePeerInput,
  parseTelegramTarget,
  extractNumericId,
  formatTarget,
  resolvePeer,
} from "./peer.js";

describe("parseTelegramTarget", () => {
  it("parses telegram-userbot:267619672 format", () => {
    const result = parseTelegramTarget("telegram-userbot:267619672");
    expect(result).toEqual({ channel: "telegram-userbot", peerId: 267619672 });
  });

  it("parses negative chat IDs", () => {
    const result = parseTelegramTarget("telegram-userbot:-1001234567890");
    expect(result).toEqual({ channel: "telegram-userbot", peerId: -1001234567890 });
  });

  it("throws on invalid prefix", () => {
    expect(() => parseTelegramTarget("telegram:267619672")).toThrow(UserbotPeerError);
  });

  it("throws on non-numeric peer ID", () => {
    expect(() => parseTelegramTarget("telegram-userbot:abc")).toThrow(UserbotPeerError);
  });

  it("throws on empty peer ID", () => {
    expect(() => parseTelegramTarget("telegram-userbot:")).toThrow(UserbotPeerError);
  });
});

describe("parsePeerInput", () => {
  it("passes through numeric IDs", () => {
    expect(parsePeerInput(267619672)).toBe(267619672);
    expect(parsePeerInput(-1001234567890)).toBe(-1001234567890);
  });

  it("converts bigint to number", () => {
    expect(parsePeerInput(BigInt(267619672))).toBe(267619672);
  });

  it("parses OpenClaw target format with numeric ID", () => {
    expect(parsePeerInput("telegram-userbot:267619672")).toBe(267619672);
    expect(parsePeerInput("telegram-userbot:-1001234567890")).toBe(-1001234567890);
  });

  it("parses OpenClaw target format with @username", () => {
    expect(parsePeerInput("telegram-userbot:@amazing_nero")).toBe("@amazing_nero");
  });

  it("parses OpenClaw target format with bare username as @prefixed", () => {
    expect(parsePeerInput("telegram-userbot:amazing_nero")).toBe("@amazing_nero");
  });

  it("passes through @username strings", () => {
    expect(parsePeerInput("@amazing_nero")).toBe("@amazing_nero");
  });

  it("parses plain numeric strings", () => {
    expect(parsePeerInput("267619672")).toBe(267619672);
  });

  it("passes through non-numeric strings as-is", () => {
    expect(parsePeerInput("some_chat")).toBe("some_chat");
  });
});

describe("extractNumericId", () => {
  it("extracts from numeric input", () => {
    expect(extractNumericId(267619672)).toBe(267619672);
  });

  it("extracts from OpenClaw target format", () => {
    expect(extractNumericId("telegram-userbot:267619672")).toBe(267619672);
  });

  it("extracts from plain numeric string", () => {
    expect(extractNumericId("267619672")).toBe(267619672);
  });

  it("returns undefined for @username input", () => {
    expect(extractNumericId("@amazing_nero")).toBeUndefined();
  });

  it("returns undefined for OpenClaw target with non-numeric value", () => {
    expect(extractNumericId("telegram-userbot:@amazing_nero")).toBeUndefined();
  });

  it("extracts from bigint input", () => {
    expect(extractNumericId(BigInt(267619672))).toBe(267619672);
  });
});

describe("formatTarget", () => {
  it("formats a numeric chat ID as OpenClaw target", () => {
    expect(formatTarget(267619672)).toBe("telegram-userbot:267619672");
    expect(formatTarget(-1001234567890)).toBe("telegram-userbot:-1001234567890");
  });
});

describe("resolvePeer", () => {
  it("calls getInputEntity on the client", async () => {
    const mockPeer = { className: "InputPeerUser", userId: 267619672 };
    const mockClient = {
      getInputEntity: vi.fn().mockResolvedValue(mockPeer),
    } as unknown as import("telegram").TelegramClient;

    const result = await resolvePeer(mockClient, 267619672);
    expect(result).toBe(mockPeer);
    expect(mockClient.getInputEntity).toHaveBeenCalledWith(267619672);
  });

  it("resolves @username via getInputEntity", async () => {
    const mockPeer = { className: "InputPeerUser", userId: 267619672 };
    const mockClient = {
      getInputEntity: vi.fn().mockResolvedValue(mockPeer),
    } as unknown as import("telegram").TelegramClient;

    const result = await resolvePeer(mockClient, "@amazing_nero");
    expect(result).toBe(mockPeer);
    expect(mockClient.getInputEntity).toHaveBeenCalledWith("@amazing_nero");
  });

  it("resolves OpenClaw target format", async () => {
    const mockPeer = { className: "InputPeerUser", userId: 267619672 };
    const mockClient = {
      getInputEntity: vi.fn().mockResolvedValue(mockPeer),
    } as unknown as import("telegram").TelegramClient;

    const result = await resolvePeer(mockClient, "telegram-userbot:267619672");
    expect(result).toBe(mockPeer);
    expect(mockClient.getInputEntity).toHaveBeenCalledWith(267619672);
  });

  it("resolves bigint peer IDs", async () => {
    const mockPeer = { className: "InputPeerUser", userId: 267619672 };
    const mockClient = {
      getInputEntity: vi.fn().mockResolvedValue(mockPeer),
    } as unknown as import("telegram").TelegramClient;

    const result = await resolvePeer(mockClient, BigInt(267619672));
    expect(result).toBe(mockPeer);
    // bigint is converted to number before passing to GramJS
    expect(mockClient.getInputEntity).toHaveBeenCalledWith(267619672);
  });

  it("throws UserbotPeerError when resolution fails", async () => {
    const mockClient = {
      getInputEntity: vi.fn().mockRejectedValue(new Error("Could not find entity")),
    } as unknown as import("telegram").TelegramClient;

    await expect(resolvePeer(mockClient, "@nonexistent")).rejects.toThrow(UserbotPeerError);
  });
});
