import {
  defineBundledChannelEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import {
  createSpectrumHealthHandler,
  createSpectrumWebhookHandler,
  initializeSpectrumRuntime,
  stopSpectrumRuntime,
} from "./src/channel.runtime.js";

export default defineBundledChannelEntry({
  id: "imessage-spectrum",
  name: "iMessage (Spectrum)",
  description: "Cross-platform iMessage channel using Spectrum by Photon",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "imessageSpectrumPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setIMessageSpectrumRuntime",
  },
  registerFull(api: OpenClawPluginApi) {
    const handler = createSpectrumWebhookHandler(api);
    const healthHandler = createSpectrumHealthHandler(api);
    api.registerHttpRoute({
      path: "/channels/imessage-spectrum/webhook",
      auth: "plugin",
      match: "exact",
      handler,
    });
    api.registerHttpRoute({
      path: "/channels/imessage-spectrum/health",
      auth: "plugin",
      match: "exact",
      handler: healthHandler,
    });

    api.logger.info?.("[imessage-spectrum] registered webhook and health routes");
    initializeSpectrumRuntime(api).catch((err) => {
      api.logger.warn?.(`[imessage-spectrum] startup initialization failed: ${String(err)}`);
    });

    api.lifecycle.registerRuntimeLifecycle({
      id: "imessage-spectrum",
      cleanup: async () => {
        stopSpectrumRuntime();
      },
    });
  },
});
