import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { matrixPlugin } from "./src/channel.js";

// Idempotency guard for setup entry to prevent duplicate initialization
let setupInitialized = false;

const wrappedPlugin = {
  ...matrixPlugin,
  async setup(api: Parameters<typeof matrixPlugin.setup>[0]) {
    if (setupInitialized) {
      api.logger.info?.("matrix: setup already initialized, skipping");
      return;
    }
    setupInitialized = true;
    if (matrixPlugin.setup) {
      await matrixPlugin.setup(api);
    }
  },
};

export default defineSetupPluginEntry(wrappedPlugin);