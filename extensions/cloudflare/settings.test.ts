import type { StorageProvider } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import { r2StorageProvider } from "./api.js";
import plugin from "./index.js";
import { r2Endpoint, type R2Settings } from "./settings.js";

const settings = {
  accountId: "0123456789abcdef0123456789abcdef",
  bucket: "openclaw-artifacts",
  accessKeyId: { source: "env", provider: "default", id: "R2_ACCESS_KEY_ID" },
  secretAccessKey: { source: "env", provider: "default", id: "R2_SECRET_ACCESS_KEY" },
} satisfies R2Settings;

describe("Cloudflare R2 provider settings", () => {
  it("registers and opens its storage provider through the plugin entrypoint", async () => {
    const providers: StorageProvider[] = [];
    plugin.register?.(
      createTestPluginApi({
        registerStorageProvider(provider) {
          providers.push(provider);
        },
      }),
    );
    expect(providers).toHaveLength(1);
    const provider = providers[0]!;
    expect(provider.id).toBe("r2");
    const resolveSecret = vi.fn(async () => "example-credential-not-real");
    const sessionToken = { source: "env", provider: "default", id: "R2_SESSION_TOKEN" };
    const backend = await provider.open({
      locationName: "offsite",
      settings: { ...settings, jurisdiction: "eu", sessionToken },
      resolveSecret,
    });
    try {
      expect(backend.displayTarget).toBe("r2://openclaw-artifacts");
      expect(resolveSecret.mock.calls).toEqual([
        [settings.accessKeyId],
        [settings.secretAccessKey],
        [sessionToken],
      ]);
    } finally {
      await backend.close?.();
    }
  });

  it("accepts a namespaced jurisdiction without a session token", () => {
    expect(
      r2StorageProvider.validateSettings?.({
        ...settings,
        prefix: "team/Archive_2026-09.30",
        jurisdiction: "fedramp",
      }),
    ).toBeUndefined();
  });

  it.each([
    ["accountId", "0123456789ABCDEF0123456789ABCDEF"],
    ["bucket", "ab"],
    ["prefix", ""],
    ["prefix", "archive/./daily"],
    ["prefix", "archive/../daily"],
    ["prefix", "a".repeat(513)],
    ["jurisdiction", "us"],
  ])("rejects invalid %s value %j", (key, value) => {
    expect(r2StorageProvider.validateSettings?.({ ...settings, [key]: value })).toContain(key);
  });

  it("requires a valid SecretRef without disclosing plaintext", () => {
    const plaintext = "example-r2-credential-not-real";
    const error = r2StorageProvider.validateSettings?.({ ...settings, accessKeyId: plaintext });
    expect(error).toContain("accessKeyId must be a valid SecretRef");
    expect(error).not.toContain(plaintext);
    expect(
      r2StorageProvider.validateSettings?.({
        ...settings,
        accessKeyId: { source: "env", provider: "default", id: "invalid-env-name" },
      }),
    ).toContain("accessKeyId must be a valid SecretRef");
  });

  it("rejects unsupported settings rather than silently using a different endpoint", () => {
    expect(
      r2StorageProvider.validateSettings?.({ ...settings, endpoint: "https://example.com" }),
    ).toContain("settings only accept");
  });

  it("uses the default endpoint without a jurisdiction", () => {
    expect(r2Endpoint(settings)).toBe(
      "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
    );
  });

  it("does not describe an invalid bucket", () => {
    expect(r2StorageProvider.describeTarget?.({ bucket: "invalid.bucket" })).toBeUndefined();
  });
});
