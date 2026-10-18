import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createMuseAgentHarness, type MuseSessionBinding } from "./harness.js";

export default definePluginEntry({
  id: "muse",
  name: "Muse Code agent runtime",
  description: "Runs Meta models through the Muse Code CLI.",
  register(api) {
    if (!["full", "discovery", "tool-discovery"].includes(api.registrationMode)) {
      return;
    }
    let store: PluginStateKeyedStore<MuseSessionBinding> | undefined;
    const getStore = () =>
      (store ??= api.runtime.state.openKeyedStore<MuseSessionBinding>({
        namespace: "msp-sessions",
        maxEntries: 5000,
        defaultTtlMs: 90 * 24 * 60 * 60 * 1000,
      }));
    const binaryPath =
      isRecord(api.pluginConfig) && typeof api.pluginConfig.binaryPath === "string"
        ? api.pluginConfig.binaryPath
        : undefined;
    api.registerAgentHarness(
      createMuseAgentHarness({
        binaryPath,
        sessionStore: {
          register: (key, value, options) => getStore().register(key, value, options),
          lookup: (key) => getStore().lookup(key),
          delete: (key) => getStore().delete(key),
        },
        logger: api.logger,
      }),
    );
  },
});
