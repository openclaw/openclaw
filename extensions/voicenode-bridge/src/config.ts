/**
 * Configuration loader for the voiceNode bridge extension.
 *
 * Merges OpenClaw plugin config with environment variable overrides.
 */

export interface BridgeConfig {
  enabled: boolean;
  port: number;
  token: string;
  toolCallTimeout: number;
  allowedTools: string[];
}

const DEFAULT_ALLOWED_TOOLS = [
  "sms_*",
  "whatsapp_*",
  "hubspot_*",
  "stripe_*",
  "salesforce_*",
  "apollo_*",
  "shopify_*",
  "quickbooks_*",
  "email_*",
  "copywriter_*",
  "slack_*",
  "calcom_*",
  "document_*",
];

/**
 * Load bridge configuration from plugin config + environment variables.
 * Environment variables take precedence.
 */
export function loadConfig(
  pluginConfig: Record<string, unknown> = {},
): BridgeConfig {
  const envEnabled = process.env.OPENCLAW_VOICENODE_BRIDGE_ENABLED;
  const envPort = process.env.OPENCLAW_VOICENODE_BRIDGE_PORT;
  const envToken = process.env.OPENCLAW_VOICENODE_BRIDGE_TOKEN;

  return {
    enabled:
      envEnabled !== undefined
        ? envEnabled === "true"
        : ((pluginConfig.enabled as boolean) ?? false),

    port:
      envPort !== undefined
        ? parseInt(envPort, 10)
        : ((pluginConfig.port as number) ?? 9100),

    token: envToken ?? (pluginConfig.token as string) ?? "",

    toolCallTimeout: (pluginConfig.toolCallTimeout as number) ?? 30000,

    allowedTools:
      (pluginConfig.allowedTools as string[]) ?? DEFAULT_ALLOWED_TOOLS,
  };
}
