import { describe, expect, it } from "vitest";
import { zaloPlugin } from "./channel.js";

describe("zalo targetResolver", () => {
  const looksLikeId = zaloPlugin.messaging?.targetResolver?.looksLikeId;

  it("accepts numeric chat_id (3+ digits)", () => {
    expect(looksLikeId?.("123456")).toBe(true);
    expect(looksLikeId?.("1234567890")).toBe(true);
  });

  it("accepts hex-like chat_id (16+ hex chars)", () => {
    expect(looksLikeId?.("5a0b1c2d3e4f5a6b")).toBe(true);
    expect(looksLikeId?.("5A0B1C2D3E4F5A6B")).toBe(true);
    expect(looksLikeId?.("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")).toBe(true);
  });

  it("rejects too short numeric strings", () => {
    expect(looksLikeId?.("12")).toBe(false);
    expect(looksLikeId?.("1")).toBe(false);
  });

  it("rejects too short hex strings", () => {
    expect(looksLikeId?.("abc123")).toBe(false);
    expect(looksLikeId?.("a1b2c3d4")).toBe(false);
  });

  it("rejects invalid characters", () => {
    expect(looksLikeId?.("hello")).toBe(false);
    expect(looksLikeId?.("zalo:123")).toBe(false);
    expect(looksLikeId?.("")).toBe(false);
  });

  it("trims whitespace before checking", () => {
    expect(looksLikeId?.("  123456  ")).toBe(true);
    expect(looksLikeId?.("  5a0b1c2d3e4f5a6b  ")).toBe(true);
  });
});
