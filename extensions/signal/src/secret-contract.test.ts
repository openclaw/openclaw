import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/runtime-secret-resolution";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";

const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });
type SecretContractSourceConfig = Omit<OpenClawConfig, "channels"> & {
  channels?: Record<string, unknown>;
};

async function resolveConfig<T extends SecretContractSourceConfig>(
  sourceConfig: T,
  env: NodeJS.ProcessEnv,
) {
  const resolvedConfig = structuredClone(sourceConfig);
  const configForResolver = sourceConfig as OpenClawConfig;
  const context = createResolverContext({ sourceConfig: configForResolver, env });
  collectRuntimeConfigAssignments({ config: resolvedConfig, defaults: undefined, context });
  const resolved = await resolveSecretRefValues(
    context.assignments.map((assignment) => assignment.ref),
    { config: configForResolver, env: context.env, cache: context.cache },
  );
  applyResolvedAssignments({ assignments: context.assignments, resolved });
  return { resolvedConfig, context };
}

describe("signal secret contract", () => {
  it("registers phone-number SecretRef targets", () => {
    expect(
      secretTargetRegistryEntries
        .map((entry) => entry.pathPattern)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual([
      "channels.signal.account",
      "channels.signal.accounts.*.account",
      "channels.signal.accounts.*.allowFrom[]",
      "channels.signal.accounts.*.defaultTo",
      "channels.signal.accounts.*.groupAllowFrom[]",
      "channels.signal.accounts.*.reactionAllowlist[]",
      "channels.signal.allowFrom[]",
      "channels.signal.defaultTo",
      "channels.signal.groupAllowFrom[]",
      "channels.signal.reactionAllowlist[]",
    ]);
  });

  it("resolves top-level and account phone-number SecretRefs", async () => {
    const sourceConfig = {
      channels: {
        signal: {
          enabled: true,
          account: envRef("SIGNAL_ACCOUNT"),
          allowFrom: [envRef("SIGNAL_OWNER")],
          defaultTo: "${SIGNAL_DEFAULT_TO}",
          groupAllowFrom: [envRef("SIGNAL_GROUP_OWNER")],
          reactionAllowlist: [envRef("SIGNAL_REACTION_OWNER")],
          accounts: {
            work: {
              enabled: true,
              account: "${SIGNAL_WORK_ACCOUNT}",
              allowFrom: [envRef("SIGNAL_WORK_OWNER")],
              defaultTo: envRef("SIGNAL_WORK_DEFAULT_TO"),
              groupAllowFrom: ["${SIGNAL_WORK_GROUP_OWNER}"],
              reactionAllowlist: [envRef("SIGNAL_WORK_REACTION_OWNER")],
            },
            inherited: {
              enabled: true,
            },
          },
        },
      },
    } satisfies SecretContractSourceConfig;

    const { resolvedConfig, context } = await resolveConfig(sourceConfig, {
      SIGNAL_ACCOUNT: "+15550001001",
      SIGNAL_OWNER: "+15550001002",
      SIGNAL_DEFAULT_TO: "+15550001003",
      SIGNAL_GROUP_OWNER: "+15550001004",
      SIGNAL_REACTION_OWNER: "+15550001005",
      SIGNAL_WORK_ACCOUNT: "+15550001006",
      SIGNAL_WORK_OWNER: "+15550001007",
      SIGNAL_WORK_DEFAULT_TO: "+15550001008",
      SIGNAL_WORK_GROUP_OWNER: "+15550001009",
      SIGNAL_WORK_REACTION_OWNER: "+15550001010",
    });

    const signal = resolvedConfig.channels?.signal;
    expect(signal?.account).toBe("+15550001001");
    expect(signal?.allowFrom).toEqual(["+15550001002"]);
    expect(signal?.defaultTo).toBe("+15550001003");
    expect(signal?.groupAllowFrom).toEqual(["+15550001004"]);
    expect(signal?.reactionAllowlist).toEqual(["+15550001005"]);
    expect(signal?.accounts?.work?.account).toBe("+15550001006");
    expect(signal?.accounts?.work?.allowFrom).toEqual(["+15550001007"]);
    expect(signal?.accounts?.work?.defaultTo).toBe("+15550001008");
    expect(signal?.accounts?.work?.groupAllowFrom).toEqual(["+15550001009"]);
    expect(signal?.accounts?.work?.reactionAllowlist).toEqual(["+15550001010"]);
    expect(context.warnings).toEqual([]);
  });
});
