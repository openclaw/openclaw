import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { createBaiduWebSearchProvider } from "./src/baidu-web-search-provider.ts";

export default definePluginEntry({
  id: "baidu",
  name: "Baidu Plugin",
  description: "Bundled Baidu plugin",
  register(api) {
    api.registerWebSearchProvider(createBaiduWebSearchProvider());
  },
});
