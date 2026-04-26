import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.js";
import { resolveSecretRefValues } from "../../../src/secrets/resolve.js";
import {
  applyResolvedAssignments,
  createResolverContext,
} from "../../../src/secrets/runtime-shared.js";
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

describe("whatsapp secret contract", () => {
  it("registers phone-number SecretRef targets", () => {
    expect(
      secretTargetRegistryEntries
        .map((entry) => entry.pathPattern)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual([
      "channels.whatsapp.accounts.*.allowFrom[]",
      "channels.whatsapp.accounts.*.defaultTo",
      "channels.whatsapp.accounts.*.groupAllowFrom[]",
      "channels.whatsapp.allowFrom[]",
      "channels.whatsapp.defaultTo",
      "channels.whatsapp.groupAllowFrom[]",
    ]);
  });

  it("resolves top-level and account phone-number SecretRefs", async () => {
    const sourceConfig = {
      channels: {
        whatsapp: {
          enabled: true,
          allowFrom: [envRef("WHATSAPP_OWNER")],
          defaultTo: "${WHATSAPP_DEFAULT_TO}",
          groupAllowFrom: [envRef("WHATSAPP_GROUP_OWNER")],
          accounts: {
            work: {
              enabled: true,
              allowFrom: [envRef("WHATSAPP_WORK_OWNER")],
              defaultTo: envRef("WHATSAPP_WORK_DEFAULT_TO"),
              groupAllowFrom: ["${WHATSAPP_WORK_GROUP_OWNER}"],
            },
            inherited: {
              enabled: true,
            },
          },
        },
      },
    } satisfies SecretContractSourceConfig;

    const { resolvedConfig, context } = await resolveConfig(sourceConfig, {
      WHATSAPP_OWNER: "+15550000001",
      WHATSAPP_DEFAULT_TO: "+15550000002",
      WHATSAPP_GROUP_OWNER: "+15550000003",
      WHATSAPP_WORK_OWNER: "+15550000004",
      WHATSAPP_WORK_DEFAULT_TO: "+15550000005",
      WHATSAPP_WORK_GROUP_OWNER: "+15550000006",
    });

    const whatsapp = resolvedConfig.channels?.whatsapp;
    expect(whatsapp?.allowFrom).toEqual(["+15550000001"]);
    expect(whatsapp?.defaultTo).toBe("+15550000002");
    expect(whatsapp?.groupAllowFrom).toEqual(["+15550000003"]);
    expect(whatsapp?.accounts?.work?.allowFrom).toEqual(["+15550000004"]);
    expect(whatsapp?.accounts?.work?.defaultTo).toBe("+15550000005");
    expect(whatsapp?.accounts?.work?.groupAllowFrom).toEqual(["+15550000006"]);
    expect(context.warnings).toEqual([]);
  });
});
