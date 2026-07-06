// Feishu tests cover secret contract plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";

async function resolveFeishuSecretAssignments(
  sourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<OpenClawConfig> {
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

  expect(context.warnings).toStrictEqual([]);
  return resolvedConfig;
}

describe("feishu secret contract", () => {
  it("assigns an enabled accountless appSecret to the default owner without a configured appId", () => {
    const sourceConfig = {
      channels: {
        feishu: {
          enabled: true,
          appSecret: {
            source: "env",
            provider: "default",
            id: "FEISHU_APP_SECRET",
          },
        },
      },
    } satisfies OpenClawConfig;
    const context = createResolverContext({ sourceConfig, env: {} });

    collectRuntimeConfigAssignments({
      config: structuredClone(sourceConfig),
      defaults: undefined,
      context,
    });

    expect(context.assignments).toMatchObject([
      {
        path: "channels.feishu.appSecret",
        ownerKind: "account",
        ownerId: "feishu:default",
      },
    ]);
    expect(context.warnings).toStrictEqual([]);
  });

  it("does not synthesize a second default owner for normalized account aliases", () => {
    const sourceConfig = {
      channels: {
        feishu: {
          enabled: true,
          appId: "top-app-id",
          appSecret: {
            source: "env",
            provider: "default",
            id: "FEISHU_UNUSED_VALUE",
          },
          accounts: {
            " default ": {
              enabled: true,
              appId: "account-app-id",
              appSecret: "fixture",
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const context = createResolverContext({ sourceConfig, env: {} });

    collectRuntimeConfigAssignments({
      config: structuredClone(sourceConfig),
      defaults: undefined,
      context,
    });

    expect(context.assignments).toStrictEqual([]);
    expect(context.warnings).toMatchObject([{ path: "channels.feishu.appSecret" }]);
  });

  it("resolves top-level websocket encryptKey SecretRefs when explicitly configured", async () => {
    const resolvedConfig = await resolveFeishuSecretAssignments(
      {
        channels: {
          feishu: {
            enabled: true,
            connectionMode: "websocket",
            appId: "cli_123",
            appSecret: "secret_456",
            encryptKey: { source: "env", provider: "default", id: "FEISHU_WS_ENCRYPT_KEY" },
          },
        },
      } as OpenClawConfig,
      { FEISHU_WS_ENCRYPT_KEY: "resolved-ws-encrypt-key" },
    );

    expect(resolvedConfig.channels?.feishu?.encryptKey).toBe("resolved-ws-encrypt-key");
  });

  it("resolves account websocket encryptKey SecretRefs when explicitly configured", async () => {
    const resolvedConfig = await resolveFeishuSecretAssignments(
      {
        channels: {
          feishu: {
            enabled: true,
            connectionMode: "websocket",
            accounts: {
              main: {
                enabled: true,
                appId: "cli_123",
                appSecret: "secret_456",
                encryptKey: {
                  source: "env",
                  provider: "default",
                  id: "FEISHU_ACCOUNT_WS_ENCRYPT_KEY",
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      { FEISHU_ACCOUNT_WS_ENCRYPT_KEY: "resolved-account-ws-encrypt-key" },
    );

    expect(resolvedConfig.channels?.feishu?.accounts?.main?.encryptKey).toBe(
      "resolved-account-ws-encrypt-key",
    );
  });
});
