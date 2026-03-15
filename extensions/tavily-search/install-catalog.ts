import type { InstallableSearchProviderPluginCatalogEntry } from "../../src/commands/search-provider-plugin-catalog.js";
import pluginManifest from "./openclaw.plugin.json";
import packageJson from "./package.json";

export const tavilySearchInstallCatalogEntry = {
  id: pluginManifest.id,
  providerId: "tavily",
  meta: {
    label: "Tavily Search",
  },
  description: "Install Tavily as a plugin search provider.",
  install: {
    npmSpec: packageJson.name,
    localPath: "extensions/tavily-search",
    defaultChoice: "local",
  },
} satisfies InstallableSearchProviderPluginCatalogEntry;
