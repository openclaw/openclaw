import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createMindsdbTool, resolveMindsdbPluginConfig } from "./src/tool.js";

const mindsdbPlugin = {
  id: "mindsdb",
  name: "MindsDB",
  description: "MindsDB Federated Query Engine tool",
  register(api: OpenClawPluginApi) {
    const config = resolveMindsdbPluginConfig(api.pluginConfig);

    if (!config.token && (!config.username || !config.password)) {
      api.logger.info(
        "[mindsdb] no token or username/password configured; assuming MindsDB auth is disabled or handled upstream",
      );
    }

    api.registerTool(createMindsdbTool(api, config), { optional: true });
  },
};

export default mindsdbPlugin;
