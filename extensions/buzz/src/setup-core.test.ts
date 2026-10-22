import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuzzConfigInput } from "./config-schema.js";
import { buzzSetupContract as setup } from "./setup-core.js";

const RELAY_URL = "wss://buzz.example.com";
const AUTH_TAG = '["auth","owner","kind=9","signature"]';
const envInput = { relayUrl: RELAY_URL, useEnv: true };
type SetupInput = Parameters<typeof setup.applyAccountConfig>[0]["input"];

function identity(name: string, key: string) {
  return { name, relayUrl: `wss://${name.toLowerCase()}.example.com`, privateKey: key.repeat(32) };
}

function config(buzz: BuzzConfigInput): OpenClawConfig {
  return { channels: { buzz } };
}

function resolveAccount(cfg: OpenClawConfig, input: SetupInput) {
  return setup.resolveAccountId?.({ cfg, accountId: "ada", input }) ?? "ada";
}

function apply(cfg: OpenClawConfig, input: SetupInput, accountId = "default") {
  return setup.applyAccountConfig({ cfg, accountId, input });
}

describe("buzzSetupContract", () => {
  afterEach(vi.unstubAllEnvs);

  it("adds a named account without changing the existing private-key SecretRef", () => {
    const buzz = {
      enabled: false,
      relayUrl: "wss://original.example.com",
      privateKey: { source: "env" as const, provider: "default", id: "BUZZ_EXISTING_KEY" },
      authTag: AUTH_TAG,
    };
    const cfg = config(buzz);
    const input = { relayUrl: "wss://new.example.com", privateKey: "22".repeat(32) };
    const accountId = resolveAccount(cfg, input);

    expect(accountId).toBe("ada");
    expect(setup.validateInput?.({ cfg, accountId, input })).toBeNull();
    const result = apply(cfg, input, accountId);
    expect(result.channels?.buzz).toEqual({
      ...buzz,
      accounts: { ada: { enabled: true, ...input } },
    });
    expect(cfg.channels?.buzz).toEqual(buzz);
  });

  it("rejects named environment-backed setup without changing the existing bot identity", () => {
    const existingPrivateKey = "11".repeat(32);
    vi.stubEnv("BUZZ_PRIVATE_KEY", existingPrivateKey);
    const buzz = {
      enabled: false,
      relayUrl: "wss://original.example.com",
      authTag: AUTH_TAG,
    };
    const cfg = config(buzz);
    const input = { relayUrl: "wss://new.example.com", useEnv: true };
    const accountId = resolveAccount(cfg, input);

    expect(accountId).toBe("ada");
    expect(setup.validateInput?.({ cfg, accountId, input })).toBe(
      "Buzz --use-env is only supported for the root default identity; use an explicit private key or SecretRef for this account.",
    );
    expect(cfg.channels?.buzz).toEqual(buzz);
    expect(process.env.BUZZ_PRIVATE_KEY).toBe(existingPrivateKey);
  });

  it("renames and reconfigures the explicit default identity without changing siblings", () => {
    const root = identity("Root", "11");
    const accounts = { ada: identity("Ada", "22"), default: identity("Default", "33") };
    const cfg = config({ ...root, accounts });
    const before = structuredClone(cfg);
    const accountId = "default";
    const renamed = setup.applyAccountName!({ cfg, accountId, name: " Renamed " });
    const replacement = { relayUrl: "wss://new.example.com", privateKey: "44".repeat(32) };
    const result = apply(renamed, replacement);
    expect(result.channels?.buzz).toEqual({
      ...root,
      accounts: { ...accounts, [accountId]: { ...replacement, name: "Renamed", enabled: true } },
    });
    expect(cfg).toEqual(before);
  });

  it.each([
    { name: "stored key", privateKey: "11".repeat(32) },
    {
      name: "unresolved SecretRef",
      privateKey: { source: "env" as const, provider: "default", id: "OTHER_BUZZ_KEY" },
    },
  ])("replaces $name with the environment without storing credentials", ({ privateKey }) => {
    expect(setup.validateInput?.({ cfg: {}, accountId: "default", input: envInput })).toBeNull();
    vi.stubEnv("BUZZ_PRIVATE_KEY", "22".repeat(32));
    const cfg = config({
      enabled: true,
      relayUrl: "wss://old.example.com",
      privateKey,
      authTag: AUTH_TAG,
    });

    const result = apply(cfg, { ...envInput, name: " Environment bot " });

    expect(result.channels?.buzz).toEqual({
      name: "Environment bot",
      enabled: true,
      relayUrl: RELAY_URL,
    });
  });
});
