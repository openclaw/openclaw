import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createBaiduWebSearchProvider } from "./src/baidu-web-search-provider.js";

export default definePluginEntry({
  id: "baidu",
  name: "Baidu Plugin",
  description: "Bundled Baidu plugin",
  register(api) {
    api.registerWebSearchProvider(createBaiduWebSearchProvider());
  },
});
