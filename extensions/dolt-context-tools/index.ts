import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createDoltReadOnlyQueryRuntime } from "./src/read-only-dolt-store.js";
import { createDoltDescribeTool } from "./src/tools/dolt-describe.js";
import { createDoltExpandTool } from "./src/tools/dolt-expand.js";
import { createDoltGrepTool } from "./src/tools/dolt-grep.js";

const doltContextToolsPlugin = {
  id: "dolt-context-tools",
  name: "Dolt Context Tools",
  version: "0.1.0",
  description: "Agent-facing tools for exploring the dolt context memory tree",
  activate(api: OpenClawPluginApi) {
    const queryRuntime = createDoltReadOnlyQueryRuntime({
      config: api.config,
      resolveStateDir: () => api.runtime.state.resolveStateDir(),
      logger: api.logger,
    });

    // Best-effort activation warmup for default/global Dolt state.
    queryRuntime.warmup();

    api.registerTool((ctx) => createDoltDescribeTool({ queries: queryRuntime.forContext(ctx) }), {
      name: "dolt_describe",
      optional: true,
    });

    api.registerTool((ctx) => createDoltExpandTool({ queries: queryRuntime.forContext(ctx) }), {
      name: "dolt_expand",
      optional: true,
    });

    api.registerTool((ctx) => createDoltGrepTool({ queries: queryRuntime.forContext(ctx) }), {
      name: "dolt_grep",
      optional: true,
    });

    api.registerService({
      id: "dolt-context-tools-store",
      start: () => {
        // No-op: query runtime is initialized at activation/first-use.
      },
      stop: () => {
        queryRuntime.dispose();
      },
    });
  },
};

export default doltContextToolsPlugin;
