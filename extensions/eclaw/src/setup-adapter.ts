/**
 * E-Claw ships with the "optional" setup surface so that when the plugin
 * is discovered but has not been configured, the setup wizard points the
 * user at the docs/npm spec instead of auto-creating credentials.
 *
 * Real credential entry is handled separately via environment variables
 * (ECLAW_API_KEY etc.) or a manual edit of openclaw.json until a native
 * wizard lands in a follow-up.
 *
 * Doc references (OpenClaw repo):
 *   - docs/plugins/sdk-channel-plugins.md §"Setup surface" — three
 *     tiers: native wizard, optional surface, or none. Optional is the
 *     correct tier for channels that haven't implemented a wizard yet
 *     (parity with synology-chat, nextcloud-talk).
 *   - docs/plugins/architecture.md §"Plugin SDK import paths" —
 *     `openclaw/plugin-sdk/channel-setup` is the stable subpath for
 *     `createOptionalChannelSetupSurface`.
 */
import { createOptionalChannelSetupSurface } from "openclaw/plugin-sdk/channel-setup";
const optionalSetup = createOptionalChannelSetupSurface({
  channel: "eclaw",
  label: "E-Claw",
  npmSpec: "@openclaw/eclaw",
  docsPath: "/channels/eclaw",
});

export const eclawSetupAdapter = optionalSetup.setupAdapter;
export const eclawSetupWizard = optionalSetup.setupWizard;
