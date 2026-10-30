import type { GoogleChatConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });
const channelConfig = <T extends GoogleChatConfig>(googlechat: T) => ({ channels: { googlechat } });
const expectedAssignment = (ownerId: string, path = "channels.googlechat.serviceAccount") => ({
  path,
  ownerId: `googlechat:${ownerId}`,
  expected: "string-or-object",
  ownerContractDigest: undefined,
});

describe("googlechat secret contract", () => {
  it("keeps inherited object credentials and explicit overrides owned by their active accounts", () => {
    const disabledRef = envRef("GOOGLECHAT_DISABLED");
    const sourceConfig = channelConfig({
      serviceAccount: envRef("GOOGLECHAT_ROOT"),
      accounts: {
        alpha: {},
        beta: {},
        override: { serviceAccount: envRef("GOOGLECHAT_OVERRIDE") },
        disabled: { enabled: false, serviceAccount: disabledRef },
      },
    });
    const config = structuredClone(sourceConfig);
    const context = createResolverContext({ sourceConfig, env: {} });

    collectRuntimeConfigAssignments({ config, context });

    expect(
      context.assignments.map(({ path, ownerId, expected, ownerContractDigest }) => ({
        path,
        ownerId,
        expected,
        ownerContractDigest,
      })),
    ).toEqual([
      expectedAssignment("alpha"),
      expectedAssignment("beta"),
      expectedAssignment("default"),
      expectedAssignment("override", "channels.googlechat.accounts.override.serviceAccount"),
    ]);
    const serviceAccount = { client_email: "synthetic@example.invalid" };
    context.assignments[0]?.apply(serviceAccount);
    expect(config.channels.googlechat.serviceAccount).toBe(serviceAccount);
    expect(config.channels.googlechat.accounts.disabled.serviceAccount).toEqual(disabledRef);
    expect(context.warnings).toEqual([
      expect.objectContaining({
        path: "channels.googlechat.accounts.disabled.serviceAccount",
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
      }),
    ]);
  });

  it("resolves account serviceAccount SecretRefs for enabled accounts", async () => {
    const sourceConfig = channelConfig({
      enabled: true,
      accounts: {
        work: { enabled: true, serviceAccount: envRef("GOOGLECHAT_SERVICE_ACCOUNT") },
      },
    });
    const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: { GOOGLECHAT_SERVICE_ACCOUNT: '{"client_email":"bot@example.com"}' },
    });

    collectRuntimeConfigAssignments({ config: resolvedConfig, context });

    expect(context.assignments).toMatchObject([
      {
        ownerKind: "account",
        ownerId: "googlechat:work",
        requiredForGateway: false,
        disposition: "isolate",
      },
    ]);

    const resolved = await resolveSecretRefValues(
      context.assignments.map((assignment) => assignment.ref),
      { config: sourceConfig, env: context.env, cache: context.cache },
    );
    applyResolvedAssignments({ assignments: context.assignments, resolved });

    const workAccount = resolvedConfig.channels?.googlechat?.accounts?.work;
    expect(workAccount?.serviceAccount).toBe('{"client_email":"bot@example.com"}');
    expect(context.warnings).toStrictEqual([]);
  });
});
