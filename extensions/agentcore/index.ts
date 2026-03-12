import type { OpenClawPluginApi } from "openclaw/plugin-sdk/acpx";
import { createAgentCoreRuntimeService } from "./src/service.js";

type AgentCorePluginConfig = {
  ssmPrefix?: string;
  region?: string;
  endpoint?: string;
  invokeTimeoutMs?: number;
};

const plugin = {
  id: "agentcore",
  name: "AgentCore Runtime",
  description: "ACP runtime backend powered by AWS Bedrock AgentCore.",
  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as AgentCorePluginConfig;

    // Derive SSM prefix from HYPERION_STAGE env var if not configured.
    const stage = process.env.HYPERION_STAGE;
    const ssmPrefix =
      pluginConfig.ssmPrefix ?? (stage ? `/hyperion/${stage}/agentcore` : undefined);

    if (!ssmPrefix) {
      api.logger.warn(
        "AgentCore plugin: no ssmPrefix configured and HYPERION_STAGE not set. " +
          "Set plugins.agentcore.ssmPrefix in config or HYPERION_STAGE env var.",
      );
      return;
    }

    const region = pluginConfig.region ?? process.env.AWS_REGION ?? "us-west-2";

    api.registerService(
      createAgentCoreRuntimeService({
        configSource: {
          ssmPrefix,
          region,
          endpointOverride: pluginConfig.endpoint,
        },
      }),
    );
  },
};

export default plugin;
