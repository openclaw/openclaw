import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk";
import { diffsPluginConfigSchema, resolveDiffsPluginDefaults } from "./src/config.js";
import { createDiffsHttpHandler } from "./src/http.js";
import { DIFFS_AGENT_GUIDANCE } from "./src/prompt-guidance.js";
import { DiffArtifactStore } from "./src/store.js";
import { createDiffsTool } from "./src/tool.js";

const plugin = {
  id: "diffs",
  name: "Diffs",
  description: "Read-only diff viewer and PNG renderer for agents.",
  configSchema: diffsPluginConfigSchema,
  register(api: OpenClawPluginApi) {
    const defaults = resolveDiffsPluginDefaults(api.pluginConfig);
    const store = new DiffArtifactStore({
      rootDir: path.join(resolvePreferredOpenClawTmpDir(), "openclaw-diffs"),
      logger: api.logger,
    });

    api.registerTool(createDiffsTool({ api, store, defaults }));
    api.registerHttpHandler(createDiffsHttpHandler({ store, logger: api.logger }));
    api.on("before_prompt_build", async () => ({
      prependContext: DIFFS_AGENT_GUIDANCE,
    }));
  },
};

export default plugin;
