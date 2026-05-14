import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { createSessionSearchPageHandler } from "./src/page.js";
import { drainSessionSearchInjection } from "./src/pending-injections.js";

const SESSION_SEARCH_PLUGIN_ID = "session-search";
const SESSION_SEARCH_BASE_PATH = `/plugins/${SESSION_SEARCH_PLUGIN_ID}`;
const SESSION_SEARCH_ENTRY_PATH = `${SESSION_SEARCH_BASE_PATH}/`;

export function registerSessionSearchPlugin(api: OpenClawPluginApi): void {
  api.on("before_prompt_build", (_event, ctx) => {
    const prependContext = drainSessionSearchInjection({ sessionKey: ctx.sessionKey });
    return prependContext ? { prependContext } : undefined;
  });

  api.registerControlUiEntryPoint({
    id: "session-search",
    surface: "app-nav",
    label: "Session Search",
    path: SESSION_SEARCH_ENTRY_PATH,
    description: "Search, inspect, inject, and resume previous OpenClaw sessions.",
    requiredScopes: ["operator.read"],
  });

  api.registerHttpRoute({
    path: SESSION_SEARCH_BASE_PATH,
    auth: "gateway",
    match: "prefix",
    handler: createSessionSearchPageHandler({
      api,
      pluginName: api.name,
      pluginVersion: api.version,
      entryPath: SESSION_SEARCH_ENTRY_PATH,
    }),
  });
}

export default definePluginEntry({
  id: SESSION_SEARCH_PLUGIN_ID,
  name: "Session Search",
  description: "Search, inspect, inject, and resume previous OpenClaw sessions.",
  register: registerSessionSearchPlugin,
});
