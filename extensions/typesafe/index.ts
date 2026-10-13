import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ConfigSchema } from "./src/config.js";
import { resolveRuntimeConfig } from "./src/credentials.js";
import { createDecisionProvider } from "./src/decisions.js";

export default definePluginEntry({
  id: "typesafe",
  name: "TypeSafe AI",
  description: "Typed decision provider for hosted Jev and local System One models.",
  configSchema: { jsonSchema: { ...ConfigSchema } },
  register(api) {
    api.registerDecisionProvider(
      createDecisionProvider(() => resolveRuntimeConfig(api.runtime.config.current())),
    );
  },
});
