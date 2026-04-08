/**
 * Bundled channel entry for the E-Claw plugin.
 *
 * Doc references (OpenClaw repo):
 *   - docs/plugins/building-plugins.md §"Plugin entry" — use
 *     `defineBundledChannelEntry` from
 *     `openclaw/plugin-sdk/channel-entry-contract`.
 *   - docs/plugins/sdk-entrypoints.md — channel entry contract shape.
 *   - docs/plugins/architecture.md §"Plugin SDK import paths" — only
 *     stable `openclaw/plugin-sdk/<subpath>` imports are allowed
 *     across the extension package boundary.
 */
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "eclaw",
  name: "E-Claw",
  description: "OpenClaw E-Claw channel plugin (Android live wallpaper character integration)",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "eclawPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setEclawRuntime",
  },
});
