import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

const DEFAULT_SLACK_ACCOUNT_ID = "default";

function normalizeSlackWebhookPath(path?: unknown): string {
  const trimmed = typeof path === "string" ? path.trim() : "";
  if (!trimmed) {
    return "/slack/events";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveSlackWebhookPaths(config: OpenClawPluginApi["config"]): string[] {
  const slack = config.channels?.slack as
    | {
        webhookPath?: unknown;
        accounts?: Record<string, { webhookPath?: unknown } | undefined>;
      }
    | undefined;
  const accountConfigs = slack?.accounts ?? {};
  const paths = new Set<string>();
  for (const accountId of new Set([DEFAULT_SLACK_ACCOUNT_ID, ...Object.keys(accountConfigs)])) {
    paths.add(
      normalizeSlackWebhookPath(accountConfigs[accountId]?.webhookPath ?? slack?.webhookPath),
    );
  }
  return [...paths].toSorted((left, right) => left.localeCompare(right));
}

function registerSlackPluginHttpRoutes(api: OpenClawPluginApi): void {
  for (const path of resolveSlackWebhookPaths(api.config)) {
    api.registerHttpRoute({
      path,
      auth: "plugin",
      handler: async (req, res) => {
        const { handleSlackHttpRequest } = await import("./src/http/registry.js");
        return await handleSlackHttpRequest(req, res);
      },
    });
  }
}

export default defineBundledChannelEntry({
  id: "slack",
  name: "Slack",
  description: "Slack channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "slackPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setSlackRuntime",
  },
  accountInspect: {
    specifier: "./account-inspect-api.js",
    exportName: "inspectSlackReadOnlyAccount",
  },
  registerFull: registerSlackPluginHttpRoutes,
});
