import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "../secret-contract-api.js";
import { LineConfigSchema } from "./config-schema.js";

function envRef(id: string) {
  return { source: "env" as const, provider: "default" as const, id };
}

async function resolveLineSecretAssignments(
  sourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<{ resolvedConfig: OpenClawConfig; warnings: Array<{ path: string }> }> {
  const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
  const context = createResolverContext({
    sourceConfig,
    env,
  });

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

  return { resolvedConfig, warnings: context.warnings };
}

describe("LINE secret contract", () => {
  it("registers LINE credential targets for openclaw.json audit", () => {
    expect(secretTargetRegistryEntries.map((entry) => entry.id)).toStrictEqual([
      "channels.line.accounts.*.channelAccessToken",
      "channels.line.accounts.*.channelSecret",
      "channels.line.channelAccessToken",
      "channels.line.channelSecret",
    ]);
  });

  it("resolves default and named account credential SecretRefs", async () => {
    const parseResult = LineConfigSchema.safeParse({
      enabled: true,
      channelAccessToken: envRef("LINE_DEFAULT_CHANNEL_ACCESS_TOKEN"),
      channelSecret: envRef("LINE_DEFAULT_CHANNEL_SECRET"),
      accounts: {
        work: {
          enabled: true,
          channelAccessToken: envRef("LINE_WORK_CHANNEL_ACCESS_TOKEN"),
          channelSecret: envRef("LINE_WORK_CHANNEL_SECRET"),
        },
      },
    });
    expect(parseResult.success).toBe(true);

    const { resolvedConfig, warnings } = await resolveLineSecretAssignments(
      {
        channels: {
          line: {
            enabled: true,
            channelAccessToken: envRef("LINE_DEFAULT_CHANNEL_ACCESS_TOKEN"),
            channelSecret: envRef("LINE_DEFAULT_CHANNEL_SECRET"),
            accounts: {
              work: {
                enabled: true,
                channelAccessToken: envRef("LINE_WORK_CHANNEL_ACCESS_TOKEN"),
                channelSecret: envRef("LINE_WORK_CHANNEL_SECRET"),
              },
            },
          },
        },
      } as OpenClawConfig,
      {
        LINE_DEFAULT_CHANNEL_ACCESS_TOKEN: "resolved-default-token",
        LINE_DEFAULT_CHANNEL_SECRET: "resolved-default-secret",
        LINE_WORK_CHANNEL_ACCESS_TOKEN: "resolved-work-token",
        LINE_WORK_CHANNEL_SECRET: "resolved-work-secret",
      },
    );

    expect(resolvedConfig.channels?.line?.channelAccessToken).toBe("resolved-default-token");
    expect(resolvedConfig.channels?.line?.channelSecret).toBe("resolved-default-secret");
    expect(resolvedConfig.channels?.line?.accounts?.work?.channelAccessToken).toBe(
      "resolved-work-token",
    );
    expect(resolvedConfig.channels?.line?.accounts?.work?.channelSecret).toBe(
      "resolved-work-secret",
    );
    expect(warnings).toStrictEqual([]);
  });

  it("leaves disabled account SecretRefs unresolved with inactive warnings", async () => {
    const { resolvedConfig, warnings } = await resolveLineSecretAssignments(
      {
        channels: {
          line: {
            enabled: true,
            accounts: {
              disabled: {
                enabled: false,
                channelAccessToken: envRef("LINE_DISABLED_CHANNEL_ACCESS_TOKEN"),
                channelSecret: envRef("LINE_DISABLED_CHANNEL_SECRET"),
              },
            },
          },
        },
      } as OpenClawConfig,
      {},
    );

    expect(resolvedConfig.channels?.line?.accounts?.disabled?.channelAccessToken).toEqual(
      envRef("LINE_DISABLED_CHANNEL_ACCESS_TOKEN"),
    );
    expect(resolvedConfig.channels?.line?.accounts?.disabled?.channelSecret).toEqual(
      envRef("LINE_DISABLED_CHANNEL_SECRET"),
    );
    expect(warnings.map((warning) => warning.path)).toStrictEqual([
      "channels.line.accounts.disabled.channelAccessToken",
      "channels.line.accounts.disabled.channelSecret",
    ]);
  });
});
