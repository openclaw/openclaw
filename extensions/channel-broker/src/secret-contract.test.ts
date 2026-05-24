import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";

describe("channel-broker secret contract", () => {
  it("declares outbound and inbound signing credentials for accounts and provider aliases", () => {
    expect(secretTargetRegistryEntries.map((entry) => entry.pathPattern)).toEqual([
      "channels.channel-broker.outboundToken",
      "channels.channel-broker.accounts.*.outboundToken",
      "channels.channel-broker.providers.*.outboundToken",
      "channels.channel-broker.signingSecret",
      "channels.channel-broker.accounts.*.signingSecret",
      "channels.channel-broker.providers.*.signingSecret",
    ]);
  });

  it("resolves active provider SecretRefs into the runtime config snapshot", async () => {
    const sourceConfig = {
      channels: {
        "channel-broker": {
          enabled: true,
          providers: {
            acme: {
              enabled: true,
              baseUrl: "https://broker.example.test",
              outboundToken: { source: "env", provider: "default", id: "BROKER_TOKEN" },
              signingSecret: { source: "env", provider: "default", id: "BROKER_SIGNING_SECRET" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {
        BROKER_TOKEN: "resolved-token",
        BROKER_SIGNING_SECRET: "resolved-signing-secret",
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

    expect(resolvedConfig.channels?.["channel-broker"]?.providers?.acme?.outboundToken).toBe(
      "resolved-token",
    );
    expect(resolvedConfig.channels?.["channel-broker"]?.providers?.acme?.signingSecret).toBe(
      "resolved-signing-secret",
    );
    expect(context.warnings).toStrictEqual([]);
  });
});
