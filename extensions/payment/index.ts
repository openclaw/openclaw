import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerPaymentApprovalsHook } from "./src/approvals.js";
import { registerPaymentCli } from "./src/cli.js";
import { defaultPaymentConfig, parsePaymentConfig } from "./src/config.js";
import { registerFillHook } from "./src/hooks/fill-hook.js";
import { registerRedactionHook } from "./src/hooks/redaction-hook.js";
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
    } catch (err) {
      // The empty-config / no-config case must NOT silently fall back to mock.
      // If the user explicitly disabled the plugin (no config), use the safe default
      // and emit a notice. If they tried to configure it but failed schema, surface.
      const isEmptyConfig =
        api.pluginConfig === undefined ||
        api.pluginConfig === null ||
        (typeof api.pluginConfig === "object" && Object.keys(api.pluginConfig).length === 0);

      if (isEmptyConfig) {
        // No user config — quietly use safe default (mock, disabled).
        config = defaultPaymentConfig();
      } else {
        // Real parse failure — surface the error so the user notices.
        // TODO: swap to api.logger once it's a stable plugin-sdk surface.
        // eslint-disable-next-line no-console
        console.error(
          "[payment] failed to parse plugin config; falling back to safe default. " +
            "Fix the config in openclaw.json. Error:",
          err,
        );
        config = defaultPaymentConfig();
      }
    }

    if (!config.enabled) {
      // Plugin loaded but disabled — don't register money-moving surfaces.
      // Redaction hook is still registered as a defense-in-depth safety net.
      registerRedactionHook(api);
      return;
    }

    const manager = createManager(config);

    registerPaymentTool(api, manager);
    registerPaymentApprovalsHook(api);
    registerPaymentCli(api, manager);
    registerFillHook(api, { manager, storePath: config.store });
    registerRedactionHook(api);
  },
});
