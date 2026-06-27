// Msteams tests cover secret contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";

async function resolveMSTeamsSecretAssignments(
  sourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<{
  config: OpenClawConfig;
  warnings: ReturnType<typeof createResolverContext>["warnings"];
}> {
  const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
  const context = createResolverContext({ sourceConfig, env });

  collectRuntimeConfigAssignments({
    config: resolvedConfig,
    defaults: sourceConfig.secrets?.defaults,
    context,
  });

  const resolved = await resolveSecretRefValues(
    context.assignments.map((assignment) => assignment.ref),
    {
      config: sourceConfig,
      env: context.env,
      cache: context.cache,
    },
  );
  applyResolvedAssignments({ assignments: context.assignments, resolved });

  return { config: resolvedConfig, warnings: context.warnings };
}

describe("msteams secret contract", () => {
  it("publishes root and account appPassword targets", () => {
    expect(secretTargetRegistryEntries.map((entry) => entry.id)).toEqual([
      "channels.msteams.accounts.*.appPassword",
      "channels.msteams.appPassword",
    ]);
  });

  it("resolves named account appPassword SecretRefs", async () => {
    const resolved = await resolveMSTeamsSecretAssignments(
      {
        channels: {
          msteams: {
            enabled: true,
            tenantId: "tenant-id",
            webhook: { path: "/api/messages" },
            accounts: {
              legal: {
                enabled: true,
                appId: "legal-app-id",
                appPassword: { source: "env", provider: "default", id: "LEGAL_MSTEAMS_SECRET" },
                webhook: { port: 3979 },
              },
            },
          },
        },
      } as OpenClawConfig,
      { LEGAL_MSTEAMS_SECRET: "resolved-legal-secret" },
    );

    expect(resolved.config.channels?.msteams?.accounts?.legal?.appPassword).toBe(
      "resolved-legal-secret",
    );
    expect(resolved.warnings).toStrictEqual([]);
  });

  it("resolves top-level appPassword SecretRefs for legacy default configs", async () => {
    const resolved = await resolveMSTeamsSecretAssignments(
      {
        channels: {
          msteams: {
            enabled: true,
            appId: "default-app-id",
            appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
            tenantId: "tenant-id",
            webhook: { port: 3978, path: "/api/messages" },
          },
        },
      } as OpenClawConfig,
      { MSTEAMS_APP_PASSWORD: "resolved-default-secret" },
    );

    expect(resolved.config.channels?.msteams?.appPassword).toBe("resolved-default-secret");
    expect(resolved.warnings).toStrictEqual([]);
  });

  it("warns instead of resolving disabled account appPassword SecretRefs", async () => {
    const resolved = await resolveMSTeamsSecretAssignments(
      {
        channels: {
          msteams: {
            enabled: true,
            tenantId: "tenant-id",
            accounts: {
              disabled: {
                enabled: false,
                appId: "disabled-app-id",
                appPassword: {
                  source: "env",
                  provider: "default",
                  id: "DISABLED_MSTEAMS_SECRET",
                },
                webhook: { port: 3980 },
              },
            },
          },
        },
      } as OpenClawConfig,
      { DISABLED_MSTEAMS_SECRET: "should-not-resolve" },
    );

    expect(resolved.config.channels?.msteams?.accounts?.disabled?.appPassword).toEqual({
      source: "env",
      provider: "default",
      id: "DISABLED_MSTEAMS_SECRET",
    });
    expect(resolved.warnings).toEqual([
      expect.objectContaining({
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.msteams.accounts.disabled.appPassword",
      }),
    ]);
  });
});
