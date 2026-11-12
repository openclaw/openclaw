/**
 * Amazon Bedrock AWS SDK auth choice.
 *
 * Bedrock accepts no API key: credentials come from the AWS SDK default chain
 * (environment variables, shared config/SSO profiles, container or instance
 * roles). This method therefore stores no credential — the saved account holds
 * the host's non-secret AWS SDK marker. The record still matters: surfaces that
 * must record which account a run used, such as scheduled automations, bind its
 * lifetime, so signing the account out revokes those bindings.
 */
import type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/core";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  applyAuthProfileConfig,
  applyProviderAuthConfigPatch,
  buildApiKeyCredential,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth";
import { upsertAuthProfileWithLockOrThrow } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  asNullableRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  AWS_SDK_CREDENTIALS_MARKER,
  BEDROCK_AWS_SDK_AUTH_METHOD_ID,
  BEDROCK_AWS_SDK_PROFILE_ID,
  BEDROCK_PROVIDER_ID,
} from "./aws-sdk-profile.js";

const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

function normalizeRegion(value: string | undefined): string | undefined {
  const region = normalizeOptionalString(value)?.toLowerCase();
  return region && REGION_PATTERN.test(region) ? region : undefined;
}

/** Region already in effect for Bedrock, so the prompt can offer it as the default. */
function resolveConfiguredRegion(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): string | undefined {
  const discovery = asNullableRecord(
    resolvePluginConfigObject(cfg, BEDROCK_PROVIDER_ID)?.discovery,
  );
  return (
    normalizeRegion(normalizeOptionalString(discovery?.region)) ??
    normalizeRegion(env.AWS_REGION) ??
    normalizeRegion(env.AWS_DEFAULT_REGION)
  );
}

/** The account record for the AWS SDK route: a marker, never AWS key material. */
function buildBedrockAwsSdkProfile() {
  return {
    profileId: BEDROCK_AWS_SDK_PROFILE_ID,
    credential: buildApiKeyCredential(BEDROCK_PROVIDER_ID, AWS_SDK_CREDENTIALS_MARKER),
  };
}

/**
 * Save the AWS SDK account. The credential is a marker, and the provider's
 * `auth: "aws-sdk"` is what makes the host resolve each request through the
 * default chain, so both are written together.
 */
export function buildBedrockAwsSdkAuthResult(params: { region?: string }): ProviderAuthResult {
  const region = normalizeRegion(params.region);
  return {
    profiles: [buildBedrockAwsSdkProfile()],
    configPatch: {
      models: { providers: { [BEDROCK_PROVIDER_ID]: { auth: "aws-sdk" } } },
      // Hosts without AWS env markers (instance roles, SSO profiles) need the
      // explicit discovery opt-in before any Bedrock model is listed.
      ...(region
        ? {
            plugins: {
              entries: {
                [BEDROCK_PROVIDER_ID]: { config: { discovery: { enabled: true, region } } },
              },
            },
          }
        : {}),
    },
    notes: [
      `Account: ${BEDROCK_AWS_SDK_PROFILE_ID} (AWS SDK default credential chain)`,
      ...(region ? [`Region: ${region}`] : []),
      "No AWS credentials are stored; each request resolves them from the chain.",
    ],
  };
}

export const awsSdkAuthMethod: ProviderAuthMethod = {
  id: BEDROCK_AWS_SDK_AUTH_METHOD_ID,
  label: "AWS credentials (SDK default chain)",
  hint: "Env vars, shared config/SSO profile, or instance role — no API key",
  kind: "custom",
  wizard: {
    choiceId: "amazon-bedrock-aws-sdk",
    choiceLabel: "Amazon Bedrock (AWS credentials)",
    choiceHint: "Env vars, shared config/SSO profile, or instance role",
    groupId: "amazon-bedrock",
    groupLabel: "Amazon Bedrock",
  },
  run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
    const env = ctx.env ?? process.env;
    await ctx.prompter.note(
      [
        "Amazon Bedrock uses the AWS SDK default credential chain: environment",
        "variables, a shared config/SSO profile, or the host's container or",
        "instance role. OpenClaw stores no AWS credentials for this account.",
      ].join("\n"),
      "Amazon Bedrock",
    );
    const answer = await ctx.prompter.text({
      message: "AWS region for Bedrock (blank keeps the AWS SDK default)",
      initialValue: resolveConfiguredRegion(ctx.config, env) ?? "",
      placeholder: "us-east-1",
      validate: (value) =>
        !normalizeOptionalString(value) || normalizeRegion(value)
          ? undefined
          : "Enter an AWS region such as us-east-1.",
    });
    return buildBedrockAwsSdkAuthResult({ region: answer });
  },
  runNonInteractive: async (ctx): Promise<OpenClawConfig> => {
    // Interactive setup lets the host persist the returned profiles; this path
    // writes the record itself, so a non-interactive install also gets the
    // account that scheduled runs bind.
    await upsertAuthProfileWithLockOrThrow({
      ...buildBedrockAwsSdkProfile(),
      agentDir: ctx.agentDir,
    });
    return applyAuthProfileConfig(
      applyProviderAuthConfigPatch(
        ctx.config,
        buildBedrockAwsSdkAuthResult({
          region: resolveConfiguredRegion(ctx.config, process.env),
        }).configPatch,
      ),
      { profileId: BEDROCK_AWS_SDK_PROFILE_ID, provider: BEDROCK_PROVIDER_ID, mode: "api_key" },
    );
  },
};
