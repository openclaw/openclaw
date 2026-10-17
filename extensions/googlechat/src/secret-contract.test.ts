// Googlechat tests cover secret contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

describe("googlechat secret contract", () => {
  it("keeps inherited object credentials and explicit overrides owned by their active accounts", () => {
    const rootRef = { source: "env", provider: "default", id: "GOOGLECHAT_ROOT" } as const;
    const overrideRef = { source: "env", provider: "default", id: "GOOGLECHAT_OVERRIDE" } as const;
    const disabledRef = { source: "env", provider: "default", id: "GOOGLECHAT_DISABLED" } as const;
    const sourceConfig = {
      channels: {
        googlechat: {
          serviceAccount: rootRef,
          accounts: {
            alpha: {},
            beta: {},
            override: { serviceAccount: overrideRef },
            disabled: { enabled: false, serviceAccount: disabledRef },
          },
        },
      },
    } satisfies OpenClawConfig;
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
      {
        path: "channels.googlechat.serviceAccount",
        ownerId: "googlechat:alpha",
        expected: "string-or-object",
        ownerContractDigest: undefined,
      },
      {
        path: "channels.googlechat.serviceAccount",
        ownerId: "googlechat:beta",
        expected: "string-or-object",
        ownerContractDigest: undefined,
      },
      {
        path: "channels.googlechat.accounts.override.serviceAccount",
        ownerId: "googlechat:override",
        expected: "string-or-object",
        ownerContractDigest: undefined,
      },
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
    const sourceConfig = {
      channels: {
        googlechat: {
          enabled: true,
          accounts: {
            work: {
              enabled: true,
              serviceAccount: {
                source: "env",
                provider: "default",
                id: "GOOGLECHAT_SERVICE_ACCOUNT",
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {
        GOOGLECHAT_SERVICE_ACCOUNT: '{"client_email":"bot@example.com"}',
      },
    });

    collectRuntimeConfigAssignments({
      config: resolvedConfig,
      defaults: undefined,
      context,
    });

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
      {
        config: sourceConfig,
        env: context.env,
        cache: context.cache,
      },
    );
    applyResolvedAssignments({
      assignments: context.assignments,
      resolved,
    });

    const workAccount = resolvedConfig.channels?.googlechat?.accounts?.work;
    expect(workAccount?.serviceAccount).toBe('{"client_email":"bot@example.com"}');
    expect(context.warnings).toStrictEqual([]);
  });
});
