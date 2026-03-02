/**
 * OpenClaw Openfort Extension
 *
 * Provides Openfort backend wallet tools to OpenClaw agents.
 * Supports EIP-7702 delegated accounts with USDC gas sponsorship.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { OpenfortClient } from "./src/client.ts";
import { createTools } from "./src/tools.ts";
import type { OpenfortConfig } from "./src/types.ts";

export default function register(api: OpenClawPluginApi) {
  const config = api.pluginConfig as OpenfortConfig | undefined;

  if (!config?.secretKey || !config?.walletSecret) {
    api.logger.warn("Openfort plugin: secretKey and walletSecret are required");
    return;
  }

  const client = new OpenfortClient(config);
  const tools = createTools(client, config, api.logger);

  // Register all tools
  tools.forEach((tool) => {
    api.registerTool(tool);
  });

  // Cleanup on shutdown (if needed in the future)
  // Currently OpenClaw doesn't have a shutdown hook in the plugin API
}
