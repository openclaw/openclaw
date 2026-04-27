import type { OpenClawPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { buildClaudeMigrationProvider } from "./provider.js";

const plugin: OpenClawPlugin = {
  id: "migrate-claude",
  register(api) {
    api.registerMigrationProvider(buildClaudeMigrationProvider({ runtime: api.runtime }));
  },
};

export default plugin;
