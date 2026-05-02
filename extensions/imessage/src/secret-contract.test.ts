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

describe("imessage secret contract", () => {
  it("registers SMS and handle SecretRef targets", () => {
    expect(
      secretTargetRegistryEntries
        .map((entry) => entry.pathPattern)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual([
      "channels.imessage.accounts.*.allowFrom[]",
      "channels.imessage.accounts.*.defaultTo",
      "channels.imessage.accounts.*.groupAllowFrom[]",
      "channels.imessage.allowFrom[]",
      "channels.imessage.defaultTo",
      "channels.imessage.groupAllowFrom[]",
    ]);
  });

  it("resolves top-level and account SecretRefs", async () => {
    const sourceConfig = {
      channels: {
        imessage: {
          enabled: true,
          allowFrom: [envRef("IMESSAGE_OWNER")],
          defaultTo: "${IMESSAGE_DEFAULT_TO}",
          groupAllowFrom: [envRef("IMESSAGE_GROUP_OWNER")],
          accounts: {
            sms: {
              enabled: true,
              allowFrom: ["${IMESSAGE_SMS_OWNER}"],
              defaultTo: envRef("IMESSAGE_SMS_DEFAULT_TO"),
              groupAllowFrom: [envRef("IMESSAGE_SMS_GROUP_OWNER")],
            },
            inherited: {
              enabled: true,
            },
          },
        },
      },
    } satisfies SecretContractSourceConfig;

    const { resolvedConfig, context } = await resolveConfig(sourceConfig, {
      IMESSAGE_OWNER: "+15550002001",
      IMESSAGE_DEFAULT_TO: "+15550002002",
      IMESSAGE_GROUP_OWNER: "+15550002003",
      IMESSAGE_SMS_OWNER: "+15550002004",
      IMESSAGE_SMS_DEFAULT_TO: "+15550002005",
      IMESSAGE_SMS_GROUP_OWNER: "+15550002006",
    });

    const imessage = resolvedConfig.channels?.imessage;
    expect(imessage?.allowFrom).toEqual(["+15550002001"]);
    expect(imessage?.defaultTo).toBe("+15550002002");
    expect(imessage?.groupAllowFrom).toEqual(["+15550002003"]);
    expect(imessage?.accounts?.sms?.allowFrom).toEqual(["+15550002004"]);
    expect(imessage?.accounts?.sms?.defaultTo).toBe("+15550002005");
    expect(imessage?.accounts?.sms?.groupAllowFrom).toEqual(["+15550002006"]);
    expect(context.warnings).toEqual([]);
  });
});
