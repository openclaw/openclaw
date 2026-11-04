/**
 * Amazon Bedrock AWS SDK auth choice.
 *
 * Bedrock accepts no API key: credentials come from the AWS SDK default chain
 * (environment variables, shared config/SSO profiles, container or instance
 * roles). This method therefore saves no credential. It declares the route in
 * config — `models.providers.amazon-bedrock.auth: "aws-sdk"` plus the
 * `amazon-bedrock:aws-sdk` auth profile — so surfaces that must record which
 * account a run used, such as scheduled automations, have a durable profile id
 * to bind instead of an anonymous ambient credential.
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
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth";
import {
  asNullableRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
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

/**
 * Declare the AWS SDK route. The profile entry carries no credential material,
 * and the provider's `auth: "aws-sdk"` is what makes the host resolve it through
 * the default chain, so both are written together.
 */
export function buildBedrockAwsSdkAuthResult(params: {
  config: OpenClawConfig;
  region?: string;
}): ProviderAuthResult {
  const region = normalizeRegion(params.region);
  const declared = applyAuthProfileConfig(params.config, {
    profileId: BEDROCK_AWS_SDK_PROFILE_ID,
    provider: BEDROCK_PROVIDER_ID,
    mode: "aws-sdk",
  });
  return {
    profiles: [],
    configPatch: {
      auth: declared.auth,
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
    return buildBedrockAwsSdkAuthResult({ config: ctx.config, region: answer });
  },
  runNonInteractive: async (ctx): Promise<OpenClawConfig> =>
    applyProviderAuthConfigPatch(
      ctx.config,
      buildBedrockAwsSdkAuthResult({
        config: ctx.config,
        region: resolveConfiguredRegion(ctx.config, process.env),
      }).configPatch,
    ),
};
