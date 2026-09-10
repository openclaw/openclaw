import { assertSecretOwnerAvailable } from "openclaw/plugin-sdk/channel-secret-owner-runtime";
// Googlechat tests cover secret contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import {
  setActiveDegradedSecretOwners,
  SecretSurfaceUnavailableError,
} from "../../../src/secrets/runtime-degraded-state.js";
import { resolveAndApplySecretAssignments } from "../../../src/secrets/runtime-owner-assignments.js";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

type ConfiguredAccount = {
  enabled?: boolean;
  serviceAccount?: unknown;
  serviceAccountFile?: string;
};

function configWithAccounts(
  accounts: Record<string, ConfiguredAccount>,
  rootServiceAccount?: unknown,
): OpenClawConfig {
  return {
    channels: {
      googlechat: {
        enabled: true,
        ...(rootServiceAccount !== undefined ? { serviceAccount: rootServiceAccount } : {}),
        accounts,
      },
    },
  } as unknown as OpenClawConfig;
}

// Env-shorthand SecretRef whose variable the tests never provide, so root-ref
// resolution fails the way an unavailable provider does in production.
const UNAVAILABLE_ROOT_REF = "\${MISSING_ROOT_GOOGLECHAT_SECRET}";

function collect(config: OpenClawConfig) {
  const resolvedConfig: OpenClawConfig = structuredClone(config);
  const context = createResolverContext({
    sourceConfig: config,
    env: {},
  });
  collectRuntimeConfigAssignments({
    config: resolvedConfig,
    defaults: undefined,
    context,
  });
  return context;
}

describe("googlechat secret contract", () => {
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

  it("does not assign the root serviceAccount SecretRef to a named account that owns a serviceAccountFile", () => {
    const context = collect(
      configWithAccounts(
        { work: { enabled: true, serviceAccountFile: "/run/secrets/work-sa.json" } },
        UNAVAILABLE_ROOT_REF,
      ),
    );

    expect(context.assignments).toStrictEqual([]);
  });

  it("keeps the default account as a root serviceAccount SecretRef owner", () => {
    const context = collect(
      configWithAccounts(
        {
          default: { enabled: true },
          work: { enabled: true, serviceAccountFile: "/run/secrets/work-sa.json" },
        },
        UNAVAILABLE_ROOT_REF,
      ),
    );

    expect(context.assignments).toMatchObject([
      { ownerKind: "account", ownerId: "googlechat:default" },
    ]);
  });

  it("keeps an unavailable root SecretRef from degrading a file-backed named account through preparation", async () => {
    const sourceConfig = configWithAccounts(
      { work: { enabled: true, serviceAccountFile: "/run/secrets/work-sa.json" } },
      UNAVAILABLE_ROOT_REF,
    );
    const context = collect(sourceConfig);

    const { degradedOwners } = await resolveAndApplySecretAssignments({
      assignments: context.assignments,
      context,
      allowOwnerIsolation: true,
      options: {
        config: sourceConfig,
        env: context.env,
        cache: context.cache,
      },
    });

    expect(degradedOwners).toStrictEqual([]);
  });

  it("isolates a named account that inherits an unavailable root SecretRef during preparation", async () => {
    const sourceConfig = configWithAccounts({ work: { enabled: true } }, UNAVAILABLE_ROOT_REF);
    const context = collect(sourceConfig);

    const { degradedOwners } = await resolveAndApplySecretAssignments({
      assignments: context.assignments,
      context,
      allowOwnerIsolation: true,
      options: {
        config: sourceConfig,
        env: context.env,
        cache: context.cache,
      },
    });

    expect(degradedOwners).toMatchObject([{ ownerKind: "account", ownerId: "googlechat:work" }]);
    // Snapshot activation publishes the degraded owner the way a real
    // preparation does; gateway startup then rejects this exact owner.
    setActiveDegradedSecretOwners(degradedOwners);
    try {
      expect(() => assertSecretOwnerAvailable("account", "googlechat:work")).toThrowError(
        SecretSurfaceUnavailableError,
      );
    } finally {
      setActiveDegradedSecretOwners([]);
    }
  });
});
