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
      settings: { ...settings, sessionToken },
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

  it.each([
    {},
    { bucket: "a-0" },
    { bucket: "a".repeat(63) },
    { prefix: "team/Archive_2026-09.30" },
    { prefix: "a".repeat(512) },
    { jurisdiction: "eu" },
    { jurisdiction: "fedramp" },
    { sessionToken: { source: "env", provider: "default", id: "R2_SESSION_TOKEN" } },
  ])("accepts supported settings %j", (overrides) => {
    expect(r2StorageProvider.validateSettings?.({ ...settings, ...overrides })).toBeUndefined();
  });

  it.each([
    ["accountId", "0123456789ABCDEF0123456789ABCDEF"],
    ["accountId", "0123456789abcdef"],
    ["accountId", "g".repeat(32)],
    ["bucket", "ab"],
    ["bucket", "a".repeat(64)],
    ["bucket", "Uppercase"],
    ["bucket", "bucket.name"],
    ["bucket", "-bucket"],
    ["bucket", "bucket-"],
    ["prefix", ""],
    ["prefix", "/archive"],
    ["prefix", "archive/"],
    ["prefix", "archive//daily"],
    ["prefix", "archive/./daily"],
    ["prefix", "archive/../daily"],
    ["prefix", "archive\\daily"],
    ["prefix", "archive/with space"],
    ["prefix", "a".repeat(513)],
    ["jurisdiction", "us"],
    ["jurisdiction", "EU"],
  ])("rejects invalid %s value %j", (key, value) => {
    expect(r2StorageProvider.validateSettings?.({ ...settings, [key]: value })).toContain(key);
  });

  it.each(["accessKeyId", "secretAccessKey", "sessionToken"])(
    "requires a valid SecretRef for %s without disclosing plaintext",
    (key) => {
      const plaintext = "example-r2-credential-not-real";
      const error = r2StorageProvider.validateSettings?.({ ...settings, [key]: plaintext });
      expect(error).toContain(`${key} must be a valid SecretRef`);
      expect(error).not.toContain(plaintext);
      expect(
        r2StorageProvider.validateSettings?.({
          ...settings,
          [key]: { source: "env", provider: "default", id: "invalid-env-name" },
        }),
      ).toContain(`${key} must be a valid SecretRef`);
    },
  );

  it.each(["accessKeyId", "secretAccessKey"])("requires %s", (key) => {
    expect(r2StorageProvider.validateSettings?.({ ...settings, [key]: undefined })).toContain(key);
  });

  it("rejects unsupported settings rather than silently using a different endpoint", () => {
    expect(
      r2StorageProvider.validateSettings?.({ ...settings, endpoint: "https://example.com" }),
    ).toContain("settings only accept");
  });

  it.each([
    [undefined, "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"],
    ["eu", "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com"],
    ["fedramp", "https://0123456789abcdef0123456789abcdef.fedramp.r2.cloudflarestorage.com"],
  ] as const)("routes jurisdiction %s to its R2 endpoint", (jurisdiction, endpoint) => {
    expect(r2Endpoint({ ...settings, jurisdiction })).toBe(endpoint);
  });

  it("describes bucket and prefix synchronously without credentials", () => {
    expect(r2StorageProvider.describeTarget?.({ bucket: "openclaw-artifacts" })).toBe(
      "r2://openclaw-artifacts",
    );
    expect(
      r2StorageProvider.describeTarget?.({ bucket: "openclaw-artifacts", prefix: "team/archive" }),
    ).toBe("r2://openclaw-artifacts/team/archive");
    expect(r2StorageProvider.describeTarget?.({ bucket: "invalid.bucket" })).toBeUndefined();
  });
});
