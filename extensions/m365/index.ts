import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { registerM365ApprovalInteractiveHandler } from "./src/approval-actions.js";
import { m365PluginConfigSchema, resolveM365PluginConfig } from "./src/config.js";
import { verifyM365MailWriteScopeProof } from "./src/runtime-common.js";
import { registerM365Tools } from "./src/tools-v2.js";
import { createM365WebhookHandler } from "./src/webhook-subscriptions.js";

async function registerM365WebhookRoute(api: OpenClawPluginApi): Promise<void> {
  const config = await resolveM365PluginConfig({
    pluginConfig: api.pluginConfig,
    config: api.config,
    env: process.env,
    logger: api.logger,
  });
  if (!config.enabled || !config.webhook.enabled) {
    return;
  }
  if (!config.webhook.clientState) {
    api.logger.warn("[m365] webhook.enabled is true but webhook.clientState is missing");
    return;
  }
  api.registerHttpRoute({
    path: config.webhook.path,
    auth: "plugin",
    match: "exact",
    replaceExisting: true,
    handler: createM365WebhookHandler({
      config,
      onNotifications: async (notifications) => {
        if (notifications.length === 0) {
          return;
        }
        api.logger.info(`[m365] received ${notifications.length} Microsoft Graph notification(s)`);
        api.runtime.system.requestHeartbeatNow({
          reason: "m365:outlook-notification",
          coalesceMs: 0,
        });
      },
    }),
  });
  api.logger.info(`[m365] registered Microsoft Graph notification route at ${config.webhook.path}`);
}

export default definePluginEntry({
  id: "m365",
  name: "Microsoft 365",
  description: "Microsoft 365 Outlook inbox triage with Teams approval-gated replies.",
  configSchema: m365PluginConfigSchema,
  async register(api) {
    const config = await resolveM365PluginConfig({
      pluginConfig: api.pluginConfig,
      config: api.config,
      env: process.env,
      logger: api.logger,
    });
    await verifyM365MailWriteScopeProof({
      config,
      deps: { env: process.env },
    });
    registerM365Tools(api);
    registerM365ApprovalInteractiveHandler(api);
    await registerM365WebhookRoute(api);
  },
});
