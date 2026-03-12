import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { createHyperionRuntime } from "../../../src/hyperion/index.js";
import { buildDynamoConfig, resolveStage } from "./env.js";
import { clearHyperionRuntime, setHyperionRuntime } from "./globals.js";

export type HyperionPluginConfig = {
  stage?: string;
  region?: string;
  dynamoEndpoint?: string;
};

/**
 * OC plugin service that creates the Hyperion multi-tenant runtime on startup.
 *
 * On start:
 *   1. Resolves stage from plugin config / env vars
 *   2. Creates AWS SDK clients (DynamoDB, KMS)
 *   3. Calls createHyperionRuntime() to wire all services
 *   4. Stores the runtime globally via setHyperionRuntime()
 *
 * On stop:
 *   Clears the global runtime reference.
 *
 * Other plugins and channel handlers access it via:
 *   import { getHyperionRuntime } from "extensions/hyperion/src/globals.js";
 */
export function createHyperionPluginService(
  pluginConfig: HyperionPluginConfig,
): OpenClawPluginService {
  return {
    id: "hyperion-runtime",

    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      const stage = resolveStage(pluginConfig.stage);
      if (!stage) {
        ctx.logger.warn(
          "Hyperion plugin: cannot determine stage. " +
            "Set plugins.hyperion.stage, HYPERION_STAGE, or STACK_NAME env var.",
        );
        return;
      }

      const region = pluginConfig.region ?? process.env.AWS_REGION ?? "us-west-2";

      const dynamoConfig = buildDynamoConfig({
        stage,
        region,
        endpoint: pluginConfig.dynamoEndpoint,
      });

      const ddbClient = new DynamoDBClient({
        region,
        ...(pluginConfig.dynamoEndpoint ? { endpoint: pluginConfig.dynamoEndpoint } : {}),
      });
      const docClient = DynamoDBDocumentClient.from(ddbClient, {
        marshallOptions: { removeUndefinedValues: true },
      });
      const kmsClient = new KMSClient({ region });

      const runtime = createHyperionRuntime({
        dynamoConfig,
        docClient,
        kmsClient,
        defaultConfig: ctx.config,
      });

      setHyperionRuntime(runtime);

      ctx.logger.info(
        `Hyperion runtime initialized (stage: ${stage}, region: ${region}, ` +
          `tables: ${dynamoConfig.tenantConfigTableName}, ...)`,
      );
    },

    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      clearHyperionRuntime();
    },
  };
}
