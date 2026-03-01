import path from "node:path";
import type { BotPluginApi } from "bot/plugin-sdk";
import { emptyPluginConfigSchema, resolvePreferredBotTmpDir } from "bot/plugin-sdk";
import { createDiffsHttpHandler } from "./src/http.js";
import { DIFFS_AGENT_GUIDANCE } from "./src/prompt-guidance.js";
import { DiffArtifactStore } from "./src/store.js";
import { createDiffsTool } from "./src/tool.js";

const plugin = {
  id: "diffs",
  name: "Diffs",
  description: "Read-only diff viewer and PNG renderer for agents.",
  configSchema: emptyPluginConfigSchema(),
  register(api: BotPluginApi) {
    const store = new DiffArtifactStore({
      rootDir: path.join(resolvePreferredBotTmpDir(), "bot-diffs"),
      logger: api.logger,
    });

    api.registerTool(createDiffsTool({ api, store }));
    api.registerHttpHandler(createDiffsHttpHandler({ store, logger: api.logger }));
    api.on("before_prompt_build", async () => ({
      prependContext: DIFFS_AGENT_GUIDANCE,
    }));
  },
};

export default plugin;
