import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NovaConfig } from "./types.js";
import { resolveNovaCredentials } from "./credentials.js";

describe("resolveNovaCredentials", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.NOVA_BASE_URL = process.env.NOVA_BASE_URL;
    savedEnv.NOVA_API_KEY = process.env.NOVA_API_KEY;
    savedEnv.NOVA_USER_ID = process.env.NOVA_USER_ID;
    savedEnv.NOVA_DEVICE_ID = process.env.NOVA_DEVICE_ID;
    delete process.env.NOVA_BASE_URL;
    delete process.env.NOVA_API_KEY;
    delete process.env.NOVA_USER_ID;
    delete process.env.NOVA_DEVICE_ID;
  });

  afterEach(() => {
    process.env.NOVA_BASE_URL = savedEnv.NOVA_BASE_URL;
    process.env.NOVA_API_KEY = savedEnv.NOVA_API_KEY;
    process.env.NOVA_USER_ID = savedEnv.NOVA_USER_ID;
    process.env.NOVA_DEVICE_ID = savedEnv.NOVA_DEVICE_ID;
  });

  it("resolves credentials from config", () => {
    const cfg: NovaConfig = {
      baseUrl: "wss://custom.example.com",
      apiKey: "key-123",
      userId: "user-001",
    };
    const result = resolveNovaCredentials(cfg);
    expect(result).toEqual(
      expect.objectContaining({
        baseUrl: "wss://custom.example.com",
        apiKey: "key-123",
        userId: "user-001",
      }),
    );
    expect(result?.deviceId).toBeDefined();
  });

  it("falls back to env vars when config is empty", () => {
    process.env.NOVA_BASE_URL = "wss://env.example.com";
    process.env.NOVA_API_KEY = "env-key";
    process.env.NOVA_USER_ID = "env-user";
    expect(resolveNovaCredentials({})).toEqual(
      expect.objectContaining({
        baseUrl: "wss://env.example.com",
        apiKey: "env-key",
        userId: "env-user",
      }),
    );
  });

  it("prefers config over env vars", () => {
    process.env.NOVA_BASE_URL = "wss://env.example.com";
    process.env.NOVA_API_KEY = "env-key";
    process.env.NOVA_USER_ID = "env-user";
    const cfg: NovaConfig = {
      baseUrl: "wss://config.example.com",
      apiKey: "cfg-key",
      userId: "cfg-user",
    };
    expect(resolveNovaCredentials(cfg)).toEqual(
      expect.objectContaining({
        baseUrl: "wss://config.example.com",
        apiKey: "cfg-key",
        userId: "cfg-user",
      }),
    );
  });

  it("uses default baseUrl when not specified", () => {
    const cfg: NovaConfig = {
      apiKey: "key",
      userId: "user",
    };
    const result = resolveNovaCredentials(cfg);
    expect(result).toBeDefined();
    expect(result?.baseUrl).toBe("wss://ws.nova-claw.agi.amazon.dev");
    expect(result?.apiKey).toBe("key");
    expect(result?.userId).toBe("user");
  });

  it("returns undefined when apiKey is missing", () => {
    const cfg: NovaConfig = {
      userId: "user",
    };
    expect(resolveNovaCredentials(cfg)).toBeUndefined();
  });

  it("returns undefined when userId is missing", () => {
    const cfg: NovaConfig = {
      apiKey: "key",
    };
    expect(resolveNovaCredentials(cfg)).toBeUndefined();
  });

  it("returns undefined for undefined config", () => {
    expect(resolveNovaCredentials(undefined)).toBeUndefined();
  });

  it("trims whitespace from values", () => {
    const cfg: NovaConfig = {
      baseUrl: "  wss://example.com  ",
      apiKey: "  key  ",
      userId: "  user  ",
    };
    expect(resolveNovaCredentials(cfg)).toEqual(
      expect.objectContaining({
        baseUrl: "wss://example.com",
        apiKey: "key",
        userId: "user",
      }),
    );
  });

  it("uses default baseUrl for whitespace-only baseUrl", () => {
    const cfg: NovaConfig = {
      baseUrl: "   ",
      apiKey: "key",
      userId: "user",
    };
    const result = resolveNovaCredentials(cfg);
    expect(result?.baseUrl).toBe("wss://ws.nova-claw.agi.amazon.dev");
  });

  it("uses deviceId from config when provided", () => {
    const cfg: NovaConfig = {
      apiKey: "key",
      userId: "user",
      deviceId: "my-device-42",
    };
    const result = resolveNovaCredentials(cfg);
    expect(result?.deviceId).toBe("my-device-42");
  });

  it("uses deviceId from env var when config is empty", () => {
    process.env.NOVA_DEVICE_ID = "env-device-99";
    const cfg: NovaConfig = {
      apiKey: "key",
      userId: "user",
    };
    const result = resolveNovaCredentials(cfg);
    expect(result?.deviceId).toBe("env-device-99");
  });

  it("generates a stable deviceId across calls when not configured", () => {
    const cfg: NovaConfig = {
      apiKey: "key",
      userId: "user",
    };
    const result1 = resolveNovaCredentials(cfg);
    const result2 = resolveNovaCredentials(cfg);
    expect(result1?.deviceId).toBeDefined();
    expect(result1?.deviceId).toBe(result2?.deviceId);
  });
});
