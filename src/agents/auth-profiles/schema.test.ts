import { describe, expect, it } from "vitest";
import { safeValidateAuthProfileStore, validateAuthProfileStore } from "./schema.js";

describe("AuthProfileStoreSchema", () => {
  it("validates a minimal valid store", () => {
    const store = {
      version: 1,
      profiles: {},
    };
    expect(() => validateAuthProfileStore(store)).not.toThrow();
  });

  it("validates store with api_key profile", () => {
    const store = {
      version: 1,
      profiles: {
        "anthropic:api": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "sk-ant-api03-xxx",
        },
      },
    };
    const result = safeValidateAuthProfileStore(store);
    expect(result.success).toBe(true);
  });

  it("validates store with token profile", () => {
    const store = {
      version: 1,
      profiles: {
        "anthropic:claude-code": {
          type: "token" as const,
          provider: "anthropic",
          token: "sk-ant-oat01-xxx",
        },
      },
    };
    const result = safeValidateAuthProfileStore(store);
    expect(result.success).toBe(true);
  });

  it("validates store with oauth profile", () => {
    const store = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "oauth" as const,
          provider: "anthropic",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 3600_000,
        },
      },
    };
    const result = safeValidateAuthProfileStore(store);
    expect(result.success).toBe(true);
  });

  it("validates store with order", () => {
    const store = {
      version: 1,
      profiles: {
        "anthropic:claude-code": {
          type: "token" as const,
          provider: "anthropic",
          token: "sk-ant-oat01-xxx",
        },
        "anthropic:api": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "sk-ant-api03-xxx",
        },
      },
      order: {
        anthropic: ["anthropic:claude-code", "anthropic:api"],
      },
    };
    const result = safeValidateAuthProfileStore(store);
    expect(result.success).toBe(true);
  });

  it("rejects missing version", () => {
    const store = {
      profiles: {},
    };
    const result = safeValidateAuthProfileStore(store);
    expect(result.success).toBe(false);
  });

  it("rejects missing profiles", () => {
    const store = {
      version: 1,
    };
    const result = safeValidateAuthProfileStore(store);
    expect(result.success).toBe(false);
  });

  it("rejects invalid profile type", () => {
    const store = {
      version: 1,
      profiles: {
        "anthropic:bad": {
          type: "invalid_type",
          provider: "anthropic",
        },
      },
    };
    const result = safeValidateAuthProfileStore(store);
    expect(result.success).toBe(false);
  });

  it("rejects 'mode' instead of 'type' (common mistake)", () => {
    const store = {
      version: 1,
      profiles: {
        "anthropic:api": {
          mode: "api_key", // WRONG - should be "type"
          provider: "anthropic",
          key: "sk-ant-api03-xxx",
        },
      },
    };
    const result = safeValidateAuthProfileStore(store);
    expect(result.success).toBe(false);
  });

  it("rejects 'apiKey' instead of 'key' (common mistake)", () => {
    const store = {
      version: 1,
      profiles: {
        "anthropic:api": {
          type: "api_key",
          provider: "anthropic",
          apiKey: "sk-ant-api03-xxx", // WRONG - should be "key"
        },
      },
    };
    const result = safeValidateAuthProfileStore(store);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Should reject unrecognized key "apiKey"
      const hasUnrecognizedKeyError = result.error.issues.some(
        (i) => i.code === "unrecognized_keys" || i.message.includes("apiKey"),
      );
      expect(hasUnrecognizedKeyError).toBe(true);
    }
  });

  it("rejects auth wrapper (common mistake - config vs store format)", () => {
    const store = {
      auth: {
        // WRONG - store format doesn't have "auth" wrapper
        version: 1,
        profiles: {},
      },
    };
    const result = safeValidateAuthProfileStore(store);
    expect(result.success).toBe(false);
  });

  it("rejects missing provider in profile", () => {
    const store = {
      version: 1,
      profiles: {
        "bad:profile": {
          type: "api_key" as const,
          // missing provider
          key: "sk-xxx",
        },
      },
    };
    const result = safeValidateAuthProfileStore(store);
    expect(result.success).toBe(false);
  });

  it("rejects token profile without token field", () => {
    const store = {
      version: 1,
      profiles: {
        "anthropic:token": {
          type: "token" as const,
          provider: "anthropic",
          // missing token
        },
      },
    };
    const result = safeValidateAuthProfileStore(store);
    expect(result.success).toBe(false);
  });

  it("validates complete real-world example", () => {
    const store = {
      version: 1,
      profiles: {
        "anthropic:claude-code": {
          type: "token" as const,
          provider: "anthropic",
          token: "sk-ant-oat01-xxx",
        },
        "anthropic:api": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "sk-ant-api03-xxx",
        },
        "openai:api": {
          type: "api_key" as const,
          provider: "openai",
          key: "sk-xxx",
        },
        "google:api": {
          type: "api_key" as const,
          provider: "google",
          key: "AIza-xxx",
        },
      },
      order: {
        anthropic: ["anthropic:claude-code", "anthropic:api"],
        openai: ["openai:api"],
        google: ["google:api"],
      },
    };
    const result = safeValidateAuthProfileStore(store);
    expect(result.success).toBe(true);
  });
});
