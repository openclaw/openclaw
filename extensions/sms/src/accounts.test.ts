import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  applyResolvedAssignments,
  createResolverContext,
  resolveSecretRefValues,
} from "openclaw/plugin-sdk/secret-ref-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectSmsAccount, listSmsAccountIds, resolveSmsAccount } from "./accounts.js";
import { SmsChannelConfigSchema } from "./config-schema.js";
import { collectRuntimeConfigAssignments } from "./secret-contract.js";
import type { SmsChannelConfig } from "./types.js";

function parseSmsConfig(value: unknown): SmsChannelConfig {
  const parsed = expectDefined(SmsChannelConfigSchema.runtime, "SMS config schema").safeParse(
    value,
  );
  if (!parsed.success) {
    throw new Error(parsed.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.data as SmsChannelConfig;
}

function config(sms: SmsChannelConfig) {
  return { channels: { sms } };
}

const tokenRef = (id: string) => ({ source: "env", provider: "default", id }) as const;
const sender = { enabled: true, accountSid: "AC123", fromNumber: "+15557654321" };
const accounts = {
  support: {
    ...sender,
    accountSid: "AC456",
    authToken: tokenRef("SUPPORT"),
    fromNumber: "+15558675309",
  },
};

async function resolveSecrets(sms: SmsChannelConfig, env: NodeJS.ProcessEnv) {
  const sourceConfig: OpenClawConfig = config(sms);
  const resolved = structuredClone(sourceConfig);
  const context = createResolverContext({ sourceConfig, env });
  collectRuntimeConfigAssignments({
    config: resolved,
    defaults: sourceConfig.secrets?.defaults,
    context,
  });
  const values = await resolveSecretRefValues(
    context.assignments.map(({ ref }) => ref),
    {
      config: sourceConfig,
      env: context.env,
      cache: context.cache,
    },
  );
  applyResolvedAssignments({ assignments: context.assignments, resolved: values });
  return { sms: resolved.channels?.sms, warnings: context.warnings };
}

afterEach(() => vi.unstubAllEnvs());

describe("SMS account config", () => {
  it("reports an invalid public webhook URL without unconfiguring SMS credentials", () => {
    expect(
      inspectSmsAccount(
        config({
          accountSid: "AC123",
          authToken: "secret",
          fromNumber: "+15557654321",
          publicWebhookUrl: "https://sms_gateway.example.com/webhooks/sms",
        }),
      ),
    ).toMatchObject({
      accountId: "default",
      name: "+15557654321",
      configured: true,
      tokenStatus: "available",
      signatureValidation: "invalid-public-url",
    });
  });

  it("inspects unavailable account credentials without using environment fallbacks or hiding healthy siblings", () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "lower-precedence-token");
    const unresolvedToken = tokenRef("OPENCLAW_TEST_UNAVAILABLE_SMS_TOKEN");
    const cfg = config({
      accountSid: "AC-parent",
      authToken: unresolvedToken,
      fromNumber: "+15550000000",
      accounts: {
        support: { authToken: unresolvedToken, messagingServiceSid: "MG-support", fromNumber: "" },
        inherited: { enabled: false },
        healthy: { authToken: "healthy-token", fromNumber: "+15551112222" },
        missing: { authToken: "" },
      },
    });

    for (const accountId of ["default", "support", "inherited"]) {
      expect(() => resolveSmsAccount(cfg, accountId)).toThrow("unresolved SecretRef");
    }
    const inspected = ["default", "support", "inherited", "healthy", "missing"].map((accountId) =>
      inspectSmsAccount(cfg, accountId),
    );
    expect(
      inspected.map(({ accountId, name, enabled, configured, tokenStatus }) => [
        accountId,
        name,
        enabled,
        configured,
        tokenStatus,
      ]),
    ).toEqual([
      ["default", "+15550000000", true, true, "configured_unavailable"],
      ["support", "MG-support", true, true, "configured_unavailable"],
      ["inherited", expect.any(String), false, true, "configured_unavailable"],
      ["healthy", "+15551112222", true, true, "available"],
      ["missing", expect.any(String), true, false, "missing"],
    ]);
    for (const account of inspected) {
      expect(account).not.toHaveProperty("authToken");
      expect(account).not.toHaveProperty("accountSid");
    }
  });

  it("treats top-level enabled false as a channel kill switch", () => {
    const cfg = config({ enabled: false, accounts: { support: { enabled: true } } });

    expect(resolveSmsAccount(cfg, "support")).toMatchObject({
      accountId: "support",
      enabled: false,
    });
  });

  it("uses env fallbacks for the default account only", () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC-env");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "env-token");
    vi.stubEnv("TWILIO_PHONE_NUMBER", "+15550001111");
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG-env");
    vi.stubEnv("SMS_WEBHOOK_PATH", "/webhooks/sms/env");
    vi.stubEnv("SMS_PUBLIC_WEBHOOK_URL", "https://sms.example.com/webhook");
    vi.stubEnv("SMS_ALLOWED_USERS", "sms:+15552223333,+15554445555");
    vi.stubEnv("SMS_DANGEROUSLY_DISABLE_SIGNATURE_VALIDATION", "true");
    vi.stubEnv("SMS_TEXT_CHUNK_LIMIT", "800");

    const cfg = config({ accounts: { support: { enabled: true } } });

    expect(listSmsAccountIds(cfg)).toEqual(["default", "support"]);
    expect(resolveSmsAccount(cfg)).toMatchObject({
      accountSid: "AC-env",
      authToken: "env-token",
      fromNumber: "+15550001111",
      messagingServiceSid: "MG-env",
      webhookPath: "/webhooks/sms/env",
      publicWebhookUrl: "https://sms.example.com/webhook",
      dangerouslyDisableSignatureValidation: true,
      allowFrom: ["+15552223333", "+15554445555"],
      textChunkLimit: 800,
    });
    expect(resolveSmsAccount(cfg, "support")).toMatchObject({
      accountId: "support",
      accountSid: "",
      authToken: "",
      fromNumber: "",
      messagingServiceSid: "",
      webhookPath: "/webhooks/sms",
      publicWebhookUrl: "",
      dangerouslyDisableSignatureValidation: false,
      allowFrom: [],
      textChunkLimit: 1500,
    });
  });

  it("keeps the default text chunk limit when SMS_TEXT_CHUNK_LIMIT is zero", () => {
    vi.stubEnv("SMS_TEXT_CHUNK_LIMIT", "0");

    expect(resolveSmsAccount({}).textChunkLimit).toBe(1500);
  });

  it("coerces numeric allowFrom entries accepted by the config schema", () => {
    const parsed = parseSmsConfig({
      accountSid: "AC123",
      authToken: "token",
      fromNumber: "+15550001111",
      allowFrom: [15551234567],
    });

    expect(resolveSmsAccount(config(parsed))).toMatchObject({ allowFrom: ["+15551234567"] });
  });

  it.each([
    ["standalone", sender, {}, false],
    ["implicit default with named accounts", { ...sender, accounts }, {}, true],
    [
      "env-backed default with named accounts",
      { enabled: true, accounts },
      { TWILIO_ACCOUNT_SID: "AC-env", TWILIO_PHONE_NUMBER: "+15550001111" },
      true,
    ],
  ] satisfies [string, SmsChannelConfig, NodeJS.ProcessEnv, boolean][])(
    "resolves the %s sender token",
    async (_name, sms, env, named) => {
      const result = await resolveSecrets(
        { ...sms, authToken: tokenRef("DEFAULT") },
        {
          DEFAULT: "resolved-default-token",
          ...(named ? { SUPPORT: "resolved-support-token" } : {}),
          ...env,
        },
      );
      expect(result.sms?.authToken).toBe("resolved-default-token");
      if (named) {
        expect(result.sms?.accounts?.support?.authToken).toBe("resolved-support-token");
      }
      expect(result.warnings).toStrictEqual([]);
    },
  );

  it("treats top-level authToken refs as inactive when all enabled accounts override them", async () => {
    const result = await resolveSecrets(
      { authToken: tokenRef("UNUSED"), accounts },
      {
        SUPPORT: "resolved-support-token",
      },
    );
    expect(result.sms?.authToken).toEqual(tokenRef("UNUSED"));
    expect(result.sms?.accounts?.support?.authToken).toBe("resolved-support-token");
    expect(result.warnings.map(({ path }) => path)).toContain("channels.sms.authToken");
  });
});
