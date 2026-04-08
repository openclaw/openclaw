/**
 * Bundled setup entry for the E-Claw plugin.
 *
 * Separated from the main `index.ts` entry so that core can import
 * the setup surface without pulling in the full channel runtime at
 * setup time (see `defineBundledChannelSetupEntry`).
 *
 * Doc references (OpenClaw repo):
 *   - docs/plugins/sdk-entrypoints.md §"Setup entry" — every bundled
 *     channel with a setup surface exposes it through a dedicated
 *     setup entry file using `defineBundledChannelSetupEntry`.
 *   - docs/plugins/building-plugins.md §"Pre-submission checklist"
 *     — "Entry point uses `defineChannelPluginEntry` or
 *     `definePluginEntry`".
 */
import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "eclawPlugin",
  },
});
