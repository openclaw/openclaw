import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redactSensitiveText } from "../logging/redact.js";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  looksLikeSecretSentinel,
  mintSecretSentinel,
  resolveSecretSentinel,
} from "../secrets/sentinel.js";
import { protectPreparedProviderRuntimeAuth } from "./provider-runtime-auth-protection.js";

beforeEach(() => resetSecretRedactionRegistryForTest());
afterEach(() => {
  vi.unstubAllEnvs();
  resetSecretRedactionRegistryForTest();
});

describe("prepared auth header classification", () => {
  it.each(["on", "off"])("preserves ordinary prose with sentinels %s", (mode) => {
    vi.stubEnv("OPENCLAW_SECRET_SENTINELS", mode);
    const metadata = {
      "Accept-Encoding": "identity",
      "CONTENT-TYPE": "application/json",
      "OpenAI-Organization": "fixture-organization",
      Accept: "text/event-stream",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "fixture-client/1.0",
    };
    const credentialHeaders = {
      Authorization: "Bearer synthetic-header-credential",
      "X-Custom-Credential": "synthetic-custom-credential",
      "X-Opaque": "synthetic-opaque-credential",
    };
    const apiKey = "synthetic-prepared-api-key";
    const result = protectPreparedProviderRuntimeAuth({
      provider: "fixture-provider",
      preparedAuth: {
        apiKey,
        request: { headers: { ...metadata, ...credentialHeaders } },
      },
    });

    for (const [name, value] of Object.entries(metadata)) {
      expect(result?.request?.headers?.[name]).toBe(value);
      expect(isSecretValueRegisteredForRedaction(value)).toBe(false);
      expect(redactSensitiveText(`Ordinary text: ${value}`, { mode: "off" })).toBe(
        `Ordinary text: ${value}`,
      );
    }
    for (const value of [apiKey, ...Object.values(credentialHeaders)]) {
      expect(isSecretValueRegisteredForRedaction(value)).toBe(true);
      expect(redactSensitiveText(value, { mode: "off" })).not.toContain(value);
    }
    for (const [name, value] of Object.entries(credentialHeaders)) {
      const protectedValue = result?.request?.headers?.[name] ?? "";
      expect(mode === "off" ? protectedValue : resolveSecretSentinel(protectedValue)).toBe(value);
    }
  });

  it("preserves explicit secret sentinels in metadata headers", () => {
    const secret = "synthetic-explicit-header-secret";
    const sentinel = mintSecretSentinel(secret, { label: "fixture:explicit-header" });
    const result = protectPreparedProviderRuntimeAuth({
      provider: "fixture-provider",
      preparedAuth: { apiKey: "synthetic-api-key", request: { headers: { Accept: sentinel } } },
    });
    expect(result?.request?.headers?.Accept).toBe(sentinel);
    expect(resolveSecretSentinel(sentinel)).toBe(secret);
    expect(redactSensitiveText(secret, { mode: "off" })).not.toContain(secret);
  });

  it.each([
    ["registered", "synthetic-duplicate-header-secret"],
    ["api-key", "synthetic-duplicate-header-secret"],
    ["api-key", "abcde"],
  ])("protects a %s value %s duplicated in metadata", (source, secret) => {
    if (source === "registered") {
      mintSecretSentinel(secret, { label: "fixture:registered" });
    }
    const result = protectPreparedProviderRuntimeAuth({
      provider: "fixture-provider",
      preparedAuth: {
        apiKey: source === "api-key" ? secret : "synthetic-other-api-key",
        request: { headers: { "Content-Type": secret } },
      },
    });
    const value = result?.request?.headers?.["Content-Type"] ?? "";
    expect(looksLikeSecretSentinel(value)).toBe(true);
    expect(resolveSecretSentinel(value)).toBe(secret);
  });

  it("protects an explicit auth header even when its name resembles metadata", () => {
    const secret = "synthetic-explicit-header-value";
    const result = protectPreparedProviderRuntimeAuth({
      provider: "fixture-provider",
      preparedAuth: {
        apiKey: "synthetic-api-key",
        request: {
          headers: { ACCEPT: `Prefix ${secret}` },
          auth: { mode: "header", headerName: "Accept", value: secret, prefix: "Prefix " },
        },
      },
    });
    const value = result?.request?.headers?.ACCEPT ?? "";
    expect(looksLikeSecretSentinel(value)).toBe(true);
    expect(resolveSecretSentinel(value)).toBe(`Prefix ${secret}`);
  });

  it.each([
    [true, "synthetic-custom-duplicate-secret"],
    [false, "synthetic-custom-duplicate-secret"],
    [true, "abcde"],
    [false, "abcde"],
  ] as const)(
    "protects custom-header duplicates with metadata first=%s and value=%s",
    (metadataFirst, secret) => {
      const headers = metadataFirst
        ? { Accept: secret, "X-Opaque": secret }
        : { "X-Opaque": secret, Accept: secret };
      const result = protectPreparedProviderRuntimeAuth({
        provider: "fixture-provider",
        preparedAuth: { apiKey: "synthetic-api-key", request: { headers } },
      });
      for (const name of Object.keys(headers)) {
        const value = result?.request?.headers?.[name] ?? "";
        expect(looksLikeSecretSentinel(value)).toBe(true);
        expect(resolveSecretSentinel(value)).toBe(secret);
      }
    },
  );

  it.each([
    ["authorization-bearer", "synthetic-explicit-auth-value"],
    ["header", "synthetic-explicit-auth-value"],
    ["authorization-bearer", "abcde"],
    ["header", "abcde"],
  ] as const)("protects explicit %s auth and its metadata alias with value=%s", (mode, secret) => {
    const auth =
      mode === "header" ? { mode, headerName: "Accept", value: secret } : { mode, token: secret };
    const result = protectPreparedProviderRuntimeAuth({
      provider: "fixture-provider",
      preparedAuth: {
        apiKey: "synthetic-api-key",
        request: { auth, headers: { "Content-Type": secret } },
      },
    });
    const protectedAuth = result?.request?.auth;
    const value =
      protectedAuth?.mode === "header"
        ? protectedAuth.value
        : protectedAuth?.mode === "authorization-bearer"
          ? protectedAuth.token
          : "";
    expect(looksLikeSecretSentinel(value)).toBe(true);
    expect(resolveSecretSentinel(value)).toBe(secret);
    const alias = result?.request?.headers?.["Content-Type"] ?? "";
    expect(looksLikeSecretSentinel(alias)).toBe(true);
    expect(resolveSecretSentinel(alias)).toBe(secret);
    if (secret.length >= 6) {
      expect(redactSensitiveText(secret, { mode: "off" })).not.toContain(secret);
    }
  });
});
