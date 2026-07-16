// Googlechat tests cover secret contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { resolveGoogleChatAccount } from "./accounts.js";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

describe("googlechat secret contract", () => {
  it("resolves account serviceAccount SecretRefs for enabled accounts", async () => {
    const sourceConfig = {
      channels: {
        googlechat: {
          enabled: true,
          accounts: {
            work: {
              enabled: true,
              serviceAccountRef: {
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
    expect(workAccount?.serviceAccountRef).toBeUndefined();
    const account = resolveGoogleChatAccount({ cfg: resolvedConfig, accountId: "work" });
    expect(account.credentialSource).toBe("inline");
    expect(account.credentials).toEqual({ client_email: "bot@example.com" });
    expect(context.warnings).toStrictEqual([]);
  });

  it("warns when account serviceAccountRef overrides plaintext serviceAccount", () => {
    const sourceConfig = {
      channels: {
        googlechat: {
          enabled: true,
          accounts: {
            work: {
              enabled: true,
              serviceAccount: { client_email: "legacy@example.com" },
              serviceAccountRef: {
                source: "env",
                provider: "default",
                id: "GOOGLECHAT_SERVICE_ACCOUNT",
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const context = createResolverContext({
      sourceConfig,
      env: {},
    });

    collectRuntimeConfigAssignments({
      config: structuredClone(sourceConfig),
      defaults: undefined,
      context,
    });

    expect(context.assignments.map((assignment) => assignment.path)).toStrictEqual([
      "channels.googlechat.accounts.work.serviceAccount",
    ]);
    expect(context.warnings).toContainEqual({
      code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
      path: "channels.googlechat.accounts.work",
      message:
        "channels.googlechat.accounts.work: serviceAccountRef is set; runtime will ignore plaintext serviceAccount.",
    });
  });

  it("does not resolve top-level serviceAccount refs for file-backed accounts", () => {
    const sourceConfig = {
      channels: {
        googlechat: {
          serviceAccountRef: {
            source: "env",
            provider: "default",
            id: "GOOGLECHAT_DEFAULT_SERVICE_ACCOUNT",
          },
          accounts: {
            work: {
              enabled: true,
              serviceAccountFile: "/tmp/work-service-account.json",
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {},
    });

    collectRuntimeConfigAssignments({
      config: resolvedConfig,
      defaults: undefined,
      context,
    });

    expect(context.assignments).toStrictEqual([]);
    expect(context.warnings.map((warning) => warning.path)).toContain(
      "channels.googlechat.serviceAccount",
    );
  });
});
