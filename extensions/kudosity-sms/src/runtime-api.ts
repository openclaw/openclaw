/**
 * Local barrel for the Kudosity SMS extension's internal imports.
 *
 * This file is the single chokepoint through which production code in
 * this extension reaches into the `openclaw/plugin-sdk/kudosity-sms`
 * subpath. All other files under `src/` must import SDK types/values
 * from `./runtime-api.js` instead of self-importing the extension's
 * public SDK subpath (see the extension self-import guardrail in
 * `extensions/CLAUDE.md`).
 */

export type {
  ChannelCapabilities,
  ChannelConfigAdapter,
  ChannelMeta,
  ChannelOutboundAdapter,
  ChannelPlugin,
  OpenClawConfig,
  PluginRuntime,
} from "openclaw/plugin-sdk/kudosity-sms";
