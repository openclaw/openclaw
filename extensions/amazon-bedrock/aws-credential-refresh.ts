/** Refresh Smithy shared config files when Bedrock needs default-chain credentials. */
export async function refreshAwsSharedConfigCacheForBedrock(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (
    env.AWS_BEDROCK_SKIP_AUTH === "1" ||
    env.AWS_BEARER_TOKEN_BEDROCK ||
    (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)
  ) {
    return;
  }
  const { loadSharedConfigFiles } = await import("@smithy/shared-ini-file-loader");
  await loadSharedConfigFiles({ ignoreCache: true });
}
