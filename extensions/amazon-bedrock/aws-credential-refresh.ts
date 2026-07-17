/**
 * AWS shared config cache refresh helpers for Bedrock. They nudge the AWS SDK
 * to re-read profile/SSO config when no static credentials are present.
 */
function hasStaticAwsCredentialEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim());
}

/** Return whether Bedrock should refresh the AWS shared config cache before discovery. */
function shouldRefreshAwsSharedConfigCacheForBedrock(env: NodeJS.ProcessEnv): boolean {
  if (env.AWS_BEDROCK_SKIP_AUTH === "1" || env.AWS_BEARER_TOKEN_BEDROCK?.trim()) {
    return false;
  }
  return !hasStaticAwsCredentialEnv(env);
}

/**
 * Clear whitespace-only static AWS credential environment variables so the AWS SDK
 * default credential chain bypasses them. The SDK's `fromEnv()` provider only checks
 * truthiness, so strings such as `" "` are selected and prevent the chain from
 * falling through to profile, SSO, ECS, or IMDS credentials.
 */
export function sanitizeBlankAwsCredentials(): void {
  if (!hasStaticAwsCredentialEnv(process.env)) {
    if (process.env.AWS_ACCESS_KEY_ID !== undefined) {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.AWS_SESSION_TOKEN;
    }
  }
}

/** Refresh Smithy shared config files when Bedrock needs default-chain credentials. */
export async function refreshAwsSharedConfigCacheForBedrock(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!shouldRefreshAwsSharedConfigCacheForBedrock(env)) {
    return;
  }
  const { loadSharedConfigFiles } = await import("@smithy/shared-ini-file-loader");
  await loadSharedConfigFiles({ ignoreCache: true });
}
