/**
 * AWS shared config cache refresh helpers for Bedrock. They nudge the AWS SDK
 * to re-read profile/SSO config when no static credentials are present.
 */
function hasStaticAwsCredentialEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim());
}

/**
 * Clear whitespace-only AWS credential environment variables so the AWS SDK
 * default credential chain bypasses them. Its env credential providers accept
 * whitespace static keys and any present Bedrock bearer-token value, preventing
 * fallback to profile, SSO, ECS, or IMDS credentials.
 */
export function sanitizeBlankAwsCredentials(env: NodeJS.ProcessEnv = process.env): void {
  if (env.AWS_BEARER_TOKEN_BEDROCK !== undefined && !env.AWS_BEARER_TOKEN_BEDROCK.trim()) {
    delete env.AWS_BEARER_TOKEN_BEDROCK;
  }

  const hasBlankAccessKey = env.AWS_ACCESS_KEY_ID !== undefined && !env.AWS_ACCESS_KEY_ID.trim();
  const hasBlankSecretKey =
    env.AWS_SECRET_ACCESS_KEY !== undefined && !env.AWS_SECRET_ACCESS_KEY.trim();

  if (hasBlankAccessKey || hasBlankSecretKey) {
    delete env.AWS_ACCESS_KEY_ID;
    delete env.AWS_SECRET_ACCESS_KEY;
    delete env.AWS_SESSION_TOKEN;
    return;
  }
  if (env.AWS_SESSION_TOKEN !== undefined && !env.AWS_SESSION_TOKEN.trim()) {
    delete env.AWS_SESSION_TOKEN;
  }
}

/** Refresh Smithy shared config files when Bedrock needs default-chain credentials. */
export async function refreshAwsSharedConfigCacheForBedrock(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // Bearer and skip-auth modes bypass the AWS credential chain. Leave the
  // process-wide AWS environment untouched for other consumers in the gateway.
  if (env.AWS_BEDROCK_SKIP_AUTH === "1" || env.AWS_BEARER_TOKEN_BEDROCK?.trim()) {
    return;
  }
  // Every default-chain Bedrock client passes through this preparation step.
  // Keep invalid env credentials out before any client resolves credentials.
  sanitizeBlankAwsCredentials(env);
  if (hasStaticAwsCredentialEnv(env)) {
    return;
  }
  const { loadSharedConfigFiles } = await import("@smithy/shared-ini-file-loader");
  await loadSharedConfigFiles({ ignoreCache: true });
}
