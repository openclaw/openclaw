import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createTinyFishWebFetchProvider } from "./src/tinyfish-fetch-provider.js";
import { createTinyFishWebSearchProvider } from "./src/tinyfish-search-provider.js";

export default definePluginEntry({
  id: "tinyfish",
  name: "TinyFish Plugin",
  description: "Bundled TinyFish search and fetch plugin",
  register(api) {
    api.registerWebFetchProvider(createTinyFishWebFetchProvider());
    api.registerWebSearchProvider(createTinyFishWebSearchProvider());
  },
});
