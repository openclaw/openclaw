import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerPaymentApprovalsHook } from "./src/approvals.js";
import { registerPaymentCli } from "./src/cli.js";
import { defaultPaymentConfig, parsePaymentConfig } from "./src/config.js";
import { createManager } from "./src/manager-factory.js";
import { registerPaymentTool } from "./src/tool.js";

export default definePluginEntry({
  id: "payment",
  name: "Payment Plugin",
  description: "Bundled payment plugin: Stripe Link CLI + mock providers",
  register(api) {
    let config;
    try {
      config = parsePaymentConfig(api.pluginConfig ?? {});
    } catch {
      config = defaultPaymentConfig();
    }

    const manager = createManager(config);

    registerPaymentTool(api, manager);
    registerPaymentApprovalsHook(api);
    registerPaymentCli(api, manager);
  },
});
