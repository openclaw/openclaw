import type { OpenClawPluginApi } from "openclaw/plugin-sdk/compat";
import { createLanceDbContextEngine } from "./src/engine.js";

const lancedbContextPlugin = {
  id: "lancedb-context",
  name: "Context Engine (LanceDB)",
  description: "LanceDB-backed context engine with same-session-key history recall",
  kind: "context-engine" as const,

  register(api: OpenClawPluginApi) {
    const engine = createLanceDbContextEngine({
      config: api.config,
      pluginConfig: api.pluginConfig,
      logger: api.logger,
      resolvePath: api.resolvePath,
    });

    api.registerContextEngine("lancedb-context", () => engine);
  },
};

export default lancedbContextPlugin;
