import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createParallelWebSearchProvider } from "./src/parallel-web-search-provider.js";

export default definePluginEntry({
  id: "parallel",
  name: "Parallel Plugin",
  description: "Bundled Parallel plugin",
  register(api) {
    api.registerWebSearchProvider(createParallelWebSearchProvider());
  },
});
