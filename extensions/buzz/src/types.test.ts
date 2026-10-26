import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, expect, it, vi } from "vitest";
import type { BuzzConfigInput } from "./config-schema.js";
import { listBuzzAccountIds, resolveBuzzAccount, resolveDefaultBuzzAccountId } from "./types.js";

const PRIVATE_KEY = "11".repeat(32);
const ENV_PRIVATE_KEY = "22".repeat(32);
const PLAINTEXT = { privateKey: PRIVATE_KEY, authTag: "configured-auth-tag" };
const EMPTY_IDENTITY = { configured: false, privateKey: "", authTag: "", relayUrl: "" };
const UNAVAILABLE = { configured: true, tokenStatus: "configured_unavailable" };
const secretRef = (id: string) => ({ source: "env", provider: "default", id }) as const;

function buzzConfig(buzz: BuzzConfigInput): OpenClawConfig {
  return { channels: { buzz } } as OpenClawConfig;
}

function rootWithAmbientCredentials(buzz: BuzzConfigInput): OpenClawConfig {
  vi.stubEnv("BUZZ_PRIVATE_KEY", ENV_PRIVATE_KEY);
  vi.stubEnv("BUZZ_AUTH_TAG", "ambient-auth");
  vi.stubEnv("BUZZ_RELAY_URL", "wss://ambient.example.com");
  return buzzConfig({
    relayUrl: "wss://root.example.com",
    privateKey: PRIVATE_KEY,
    authTag: "root-auth",
    ...buzz,
  });
}

afterEach(() => vi.unstubAllEnvs());

it("discovers the default account from a configured private-key SecretRef", () => {
  const cfg = buzzConfig({
    privateKey: { source: "file", provider: "vault", id: "/buzz/private-key" },
  });

  expect(listBuzzAccountIds(cfg)).toEqual(["default"]);
});
it("isolates named identities and never fills missing fields from root credentials", () => {
  const ada = { relayUrl: "wss://ada.example.com", privateKey: "33".repeat(32), name: "Ada" };
  const cfg = rootWithAmbientCredentials({
    groupPolicy: "open",
    groups: { "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c": {} },
    accounts: { ada, empty: {} },
  });
  expect(listBuzzAccountIds(cfg)).toEqual(["ada", "default", "empty"]);
  expect(resolveDefaultBuzzAccountId(cfg)).toBe("default");
  expect(resolveBuzzAccount({ cfg, accountId: "ada" })).toMatchObject({
    accountId: "ada",
    ...ada,
    authTag: "",
    config: { groupPolicy: "open", groups: undefined },
  });
  expect(resolveBuzzAccount({ cfg, accountId: "empty" })).toMatchObject({
    accountId: "empty",
    ...EMPTY_IDENTITY,
  });
  expect(resolveBuzzAccount({ cfg, accountId: "default" }).privateKey).toBe(PRIVATE_KEY);
});

it("treats an explicit default account as a complete identity boundary", () => {
  const cfg = rootWithAmbientCredentials({
    accounts: { default: { name: "Explicit default" } },
  });
  expect(resolveBuzzAccount({ cfg })).toMatchObject({
    accountId: "default",
    name: "Explicit default",
    ...EMPTY_IDENTITY,
    config: { groupPolicy: "allowlist" },
  });
});

it("selects a configured default deterministically and applies the global disabled gate", () => {
  vi.stubEnv("BUZZ_PRIVATE_KEY", "");
  vi.stubEnv("BUZZ_RELAY_URL", "");
  const cfg = buzzConfig({
    enabled: false,
    defaultAccount: "second",
    accounts: { first: {}, second: { enabled: true } },
  });
  expect(listBuzzAccountIds(cfg)).toEqual(["first", "second"]);
  expect(resolveDefaultBuzzAccountId(cfg)).toBe("second");
  expect(resolveBuzzAccount({ cfg })).toMatchObject({ accountId: "second", enabled: false });
});

it.each([
  [
    "keeps explicit plaintext credentials ahead of ambient credentials",
    PLAINTEXT,
    { BUZZ_PRIVATE_KEY: ENV_PRIVATE_KEY, BUZZ_AUTH_TAG: "ambient-auth-tag" },
    { ...PLAINTEXT, configured: true, tokenStatus: "available" },
  ],
  [
    "distinguishes a missing private key from a configured unavailable key",
    {},
    { BUZZ_PRIVATE_KEY: "" },
    { configured: false, privateKey: "", tokenStatus: "missing" },
  ],
] as const)("%s", (_label, credentials, env, expected) => {
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value);
  }
  const cfg = buzzConfig({ relayUrl: "wss://buzz.example.com", ...credentials });

  expect(resolveBuzzAccount({ cfg })).toMatchObject(expected);
});

it.each(["privateKey", "authTag"] as const)(
  "never substitutes ambient %s for a SecretRef",
  (field) => {
    const cfg = rootWithAmbientCredentials({ [field]: secretRef("MISSING_BUZZ_CREDENTIAL") });
    expect(resolveBuzzAccount({ cfg })).toMatchObject({
      ...UNAVAILABLE,
      privateKey: field === "privateKey" ? "" : PRIVATE_KEY,
      authTag: field === "authTag" ? "" : "root-auth",
      publicKey: field === "privateKey" ? "" : expect.stringMatching(/./),
    });
  },
);
