import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";
import type { SmsChannelConfig } from "./types.js";

const tokenRef = (id: string) => ({ source: "env", provider: "default", id }) as const;
const sender = { enabled: true, accountSid: "AC123", fromNumber: "+15557654321" };
const accounts = {
  support: {
    enabled: true,
    accountSid: "AC456",
    authToken: tokenRef("TWILIO_SUPPORT_TOKEN"),
    fromNumber: "+15558675309",
  },
};
const tokens = {
  TWILIO_DEFAULT_TOKEN: "resolved-default-token",
  TWILIO_SUPPORT_TOKEN: "resolved-support-token",
};

async function resolveSmsSecretAssignments(sms: SmsChannelConfig, env: NodeJS.ProcessEnv) {
  const sourceConfig: OpenClawConfig = { channels: { sms } };
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

describe("sms secret contract", () => {
  it("resolves top-level authToken SecretRefs for SMS accounts", async () => {
    const resolved = await resolveSmsSecretAssignments(
      { ...sender, authToken: tokenRef("TWILIO_AUTH_TOKEN") },
      { TWILIO_AUTH_TOKEN: "resolved-token" },
    );

    expect(resolved.config.channels?.sms?.authToken).toBe("resolved-token");
    expect(resolved.warnings).toStrictEqual([]);
  });

  it("keeps top-level authToken active for an implicit default sender plus named accounts", async () => {
    const resolved = await resolveSmsSecretAssignments(
      { ...sender, authToken: tokenRef("TWILIO_DEFAULT_TOKEN"), accounts },
      tokens,
    );

    expect(resolved.config.channels?.sms?.authToken).toBe("resolved-default-token");
    expect(resolved.config.channels?.sms?.accounts?.support?.authToken).toBe(
      "resolved-support-token",
    );
    expect(resolved.warnings).toStrictEqual([]);
  });

  it("keeps top-level authToken active for env-backed default senders plus named accounts", async () => {
    const resolved = await resolveSmsSecretAssignments(
      { enabled: true, authToken: tokenRef("TWILIO_DEFAULT_TOKEN"), accounts },
      {
        ...tokens,
        TWILIO_ACCOUNT_SID: "AC-env",
        TWILIO_PHONE_NUMBER: "+15550001111",
      },
    );

    expect(resolved.config.channels?.sms?.authToken).toBe("resolved-default-token");
    expect(resolved.config.channels?.sms?.accounts?.support?.authToken).toBe(
      "resolved-support-token",
    );
    expect(resolved.warnings).toStrictEqual([]);
  });

  it("treats top-level authToken refs as inactive when all enabled accounts override them", async () => {
    const resolved = await resolveSmsSecretAssignments(
      { authToken: tokenRef("UNUSED_TWILIO_TOKEN"), accounts },
      { TWILIO_SUPPORT_TOKEN: "resolved-support-token" },
    );

    expect(resolved.config.channels?.sms?.authToken).toEqual({
      source: "env",
      provider: "default",
      id: "UNUSED_TWILIO_TOKEN",
    });
    expect(resolved.config.channels?.sms?.accounts?.support?.authToken).toBe(
      "resolved-support-token",
    );
    expect(resolved.warnings.map((warning) => warning.path)).toContain("channels.sms.authToken");
  });
});
