import { describe, expect, it } from "vitest";
import type { NovaConfig } from "./types.js";
import { probeNova } from "./probe.js";

describe("probeNova", () => {
  it("returns ok for valid config with default baseUrl", () => {
    const cfg: NovaConfig = {
      apiKey: "key-123",
      userId: "user-001",
    };
    expect(probeNova(cfg)).toEqual({ ok: true, userId: "user-001" });
  });

  it("returns ok for valid config with custom baseUrl", () => {
    const cfg: NovaConfig = {
      baseUrl: "wss://custom.example.com",
      apiKey: "key-123",
      userId: "user-001",
    };
    expect(probeNova(cfg)).toEqual({ ok: true, userId: "user-001" });
  });

  it("returns error when credentials are missing", () => {
    expect(probeNova({ enabled: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining("missing credentials"),
    });
  });

  it("returns error when credentials are undefined", () => {
    expect(probeNova(undefined)).toMatchObject({
      ok: false,
      error: expect.stringContaining("missing credentials"),
    });
  });

  it("returns error for non-wss baseUrl", () => {
    const cfg: NovaConfig = {
      baseUrl: "https://example.com/prod",
      apiKey: "key-123",
      userId: "user-001",
    };
    const result = probeNova(cfg);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("wss://");
  });

  it("returns error for invalid baseUrl", () => {
    const cfg: NovaConfig = {
      baseUrl: "not-a-url",
      apiKey: "key-123",
      userId: "user-001",
    };
    const result = probeNova(cfg);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a valid URL");
  });

  it("accepts ws:// protocol", () => {
    const cfg: NovaConfig = {
      baseUrl: "ws://localhost:8080/dev",
      apiKey: "key-123",
      userId: "user-001",
    };
    expect(probeNova(cfg)).toEqual({ ok: true, userId: "user-001" });
  });
});
