import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
// Import the slash route registration statically so `./src/mattermost/slash-state.ts`
// loads through the same native-ESM module instance as `monitor-slash.ts` (which
// calls `activateSlashCommands`) and `monitor.ts` (which calls
// `deactivateSlashCommands` / `getSlashCommandState`). Going through the sync
// jiti loader (`loadBundledEntryExportSync`) would create a second instance of
// `slash-state.ts` whose `accountStates` map is never populated, so the HTTP
// route would keep returning 503 "Slash commands are not yet initialized" even
// after activation succeeds. See SDK guidance: do not mix static and dynamic
// imports for the same runtime surface.
import { registerSlashCommandRoute } from "./slash-route-api.js";

export default defineBundledChannelEntry({
  id: "mattermost",
  name: "Mattermost",
  description: "Mattermost channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "mattermostPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setMattermostRuntime",
  },
  registerFull(api) {
    // Actual slash-command registration happens after the monitor connects and
    // knows the team id; the route itself can be wired here.
    registerSlashCommandRoute(api);
  },
});
