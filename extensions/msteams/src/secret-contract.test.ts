import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

async function resolveMSTeamsSecretAssignments(
  msteams: NonNullable<OpenClawConfig["channels"]>["msteams"],
  env: NodeJS.ProcessEnv,
) {
  const sourceConfig: OpenClawConfig = { channels: { msteams } };
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

  return { config: resolvedConfig, assignments: context.assignments, warnings: context.warnings };
}

const secretRef = { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" } as const;
const ignored = (path: string) => [
  expect.objectContaining({ code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE", path }),
];

describe("msteams secret contract", () => {
  it("resolves named account appPassword SecretRefs", async () => {
    const resolved = await resolveMSTeamsSecretAssignments(
      {
        enabled: true,
        accounts: {
          support: {
            enabled: true,
            appId: "support-app-id",
            appPassword: { source: "env", provider: "default", id: "SUPPORT_MSTEAMS_SECRET" },
          },
        },
      },
      { SUPPORT_MSTEAMS_SECRET: "resolved-support-secret" },
    );

    expect(resolved.config.channels?.msteams?.accounts?.support?.appPassword).toBe(
      "resolved-support-secret",
    );
    expect(resolved.assignments).toMatchObject([
      {
        ownerKind: "account",
        ownerId: "msteams:support",
        requiredForGateway: false,
        disposition: "isolate",
      },
    ]);
    expect(resolved.warnings).toStrictEqual([]);
  });

  it("resolves top-level appPassword SecretRefs for legacy default configs", async () => {
    const resolved = await resolveMSTeamsSecretAssignments(
      {
        enabled: true,
        appId: "default-app-id",
        appPassword: secretRef,
      },
      { MSTEAMS_APP_PASSWORD: "resolved-default-secret" },
    );

    expect(resolved.config.channels?.msteams?.appPassword).toBe("resolved-default-secret");
    expect(resolved.warnings).toStrictEqual([]);
  });

  it("does not resolve a root appPassword when the canonical default account is disabled", async () => {
    const resolved = await resolveMSTeamsSecretAssignments(
      {
        enabled: true,
        appId: "default-app-id",
        appPassword: secretRef,
        accounts: {
          Default: { enabled: false },
          support: {
            enabled: true,
            appId: "support-app-id",
            appPassword: "support-secret",
          },
        },
      },
      { MSTEAMS_APP_PASSWORD: "should-not-resolve" },
    );

    expect(resolved.config.channels?.msteams?.appPassword).toEqual(secretRef);
    expect(resolved.warnings).toEqual(ignored("channels.msteams.appPassword"));
  });

  it("does not resolve a root appPassword when the channel is globally disabled", async () => {
    const resolved = await resolveMSTeamsSecretAssignments(
      {
        enabled: false,
        appId: "default-app-id",
        appPassword: secretRef,
        accounts: {
          default: { enabled: true },
        },
      },
      { MSTEAMS_APP_PASSWORD: "should-not-resolve" },
    );

    expect(resolved.config.channels?.msteams?.appPassword).toEqual(secretRef);
    expect(resolved.warnings).toEqual(ignored("channels.msteams.appPassword"));
  });

  it("warns instead of resolving disabled account appPassword SecretRefs", async () => {
    const resolved = await resolveMSTeamsSecretAssignments(
      {
        enabled: true,
        accounts: {
          disabled: {
            enabled: false,
            appId: "disabled-app-id",
            appPassword: secretRef,
          },
        },
      },
      { MSTEAMS_APP_PASSWORD: "should-not-resolve" },
    );

    expect(resolved.config.channels?.msteams?.accounts?.disabled?.appPassword).toEqual(secretRef);
    expect(resolved.warnings).toEqual(ignored("channels.msteams.accounts.disabled.appPassword"));
  });
});
