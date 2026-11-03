import { createResolverContext } from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it, vi } from "vitest";
import type { BuzzConfigInput } from "./config-schema.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";

// mock-isolation: credential metadata must not evaluate the Nostr execution runtime.
vi.mock("nostr-tools", () => {
  throw new Error("Buzz secret metadata must not load the Nostr runtime");
});

const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });

function collect(buzz: BuzzConfigInput) {
  const sourceConfig = { channels: { buzz } };
  const config = structuredClone(sourceConfig);
  const context = createResolverContext({ sourceConfig, env: {} });
  collectRuntimeConfigAssignments({ config, defaults: undefined, context });
  return { buzz: config.channels.buzz, context };
}

describe("Buzz secret contract", () => {
  it("publishes Buzz credential targets", () => {
    expect(secretTargetRegistryEntries.map((entry) => entry.id)).toEqual([
      "channels.buzz.accounts.*.privateKey",
      "channels.buzz.accounts.*.authTag",
      "channels.buzz.privateKey",
      "channels.buzz.authTag",
    ]);
  });

  it.each([
    { explicitDefault: false, enabled: true, owners: ["buzz:default", "buzz:ada"] },
    { explicitDefault: true, enabled: true, owners: ["buzz:ada"] },
    { explicitDefault: false, enabled: false, owners: [] },
  ])("isolates active credential owners: %j", ({ explicitDefault, enabled, owners }) => {
    const { buzz, context } = collect({
      enabled,
      privateKey: envRef("ROOT_KEY"),
      accounts: {
        ...(explicitDefault ? { default: {} } : {}),
        ada: { privateKey: envRef("ADA_KEY") },
        paused: { enabled: false, privateKey: envRef("PAUSED_KEY") },
      },
    });
    expect(context.assignments.map((assignment) => assignment.ownerId)).toEqual(owners);
    for (const assignment of context.assignments) {
      expect(assignment).toMatchObject({ requiredForGateway: false, disposition: "isolate" });
      assignment.apply(`resolved-${assignment.ownerId}`);
    }
    expect({ root: buzz.privateKey, ada: buzz.accounts?.ada?.privateKey }).toEqual({
      root: enabled && !explicitDefault ? "resolved-buzz:default" : envRef("ROOT_KEY"),
      ada: enabled ? "resolved-buzz:ada" : envRef("ADA_KEY"),
    });
  });

  it("binds recovery to only the selected identity and its effective policy", () => {
    const source: BuzzConfigInput = {
      privateKey: "root-key",
      groupPolicy: "open",
      accounts: {
        ada: { relayUrl: "wss://ada.example.com", privateKey: envRef("ADA_KEY") },
        grace: { privateKey: "grace-key" },
      },
    };
    const digest = (config: BuzzConfigInput) =>
      collect(config).context.assignments.find((entry) => entry.ownerId === "buzz:ada")
        ?.ownerContractDigest;
    const baseline = digest(source);
    expect(baseline).toBeTypeOf("string");
    const otherIdentity = structuredClone(source);
    otherIdentity.privateKey = "rotated-root";
    otherIdentity.accounts!.grace!.privateKey = "rotated-grace";
    otherIdentity.defaultAccount = "grace";
    expect(digest(otherIdentity)).toBe(baseline);
    const ownIdentity = structuredClone(source);
    ownIdentity.accounts!.ada!.relayUrl = "wss://changed.example.com";
    expect(digest(ownIdentity)).not.toBe(baseline);
    const policy = structuredClone(source);
    policy.groupPolicy = "allowlist";
    expect(digest(policy)).not.toBe(baseline);
  });

  it("collects configured Buzz SecretRefs", () => {
    const privateKey = { source: "file" as const, provider: "vault", id: "/buzz/private-key" };
    const authTag = { source: "exec" as const, provider: "vault", id: "buzz-auth-tag" };
    const { context } = collect({ privateKey, authTag });
    expect(context.assignments.map(({ path, ref }) => [path, ref])).toEqual([
      ["channels.buzz.privateKey", privateKey],
      ["channels.buzz.authTag", authTag],
    ]);
    expect(context.warnings).toStrictEqual([]);
  });
});
