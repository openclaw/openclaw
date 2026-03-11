import type { HyperionDynamoDBConfig } from "../../../src/hyperion/types.js";

/**
 * Resolve the Hyperion stage from environment or plugin config.
 *
 * Priority:
 *   1. Plugin config `stage` field
 *   2. `HYPERION_STAGE` env var
 *   3. Derived from `STACK_NAME` env var (e.g. "Hyperion-beta" → "beta")
 */
export function resolveStage(pluginStage?: string): string | null {
  if (pluginStage) return pluginStage;
  if (process.env.HYPERION_STAGE) return process.env.HYPERION_STAGE;
  const stackName = process.env.STACK_NAME;
  if (stackName?.startsWith("Hyperion-")) {
    return stackName.replace("Hyperion-", "");
  }
  return null;
}

/**
 * Build DynamoDB config from stage name.
 * Table names and KMS key alias follow the CDK naming convention.
 */
export function buildDynamoConfig(params: {
  stage: string;
  region: string;
  endpoint?: string;
}): HyperionDynamoDBConfig {
  const { stage, region, endpoint } = params;
  return {
    region,
    tenantConfigTableName: `Hyperion-${stage}-tenant-config`,
    channelConfigTableName: `Hyperion-${stage}-channel-config`,
    pairingCodesTableName: `Hyperion-${stage}-pairing-codes`,
    userCredentialsTableName: `Hyperion-${stage}-user-credentials`,
    credentialsKmsKeyId: `alias/hyperion-${stage}-credentials`,
    channelConfigUserIdIndexName: "user_id-index",
    ...(endpoint ? { endpoint } : {}),
  };
}
