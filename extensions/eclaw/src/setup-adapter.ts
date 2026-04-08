import { createOptionalChannelSetupSurface } from "openclaw/plugin-sdk/channel-setup";

/**
 * E-Claw ships with the "optional" setup surface so that when the plugin
 * is discovered but has not been configured, the setup wizard points the
 * user at the docs/npm spec instead of auto-creating credentials.
 *
 * Real credential entry is handled separately via environment variables
 * (ECLAW_API_KEY etc.) or a manual edit of openclaw.json until a native
 * wizard lands in a follow-up.
 */
const optionalSetup = createOptionalChannelSetupSurface({
  channel: "eclaw",
  label: "E-Claw",
  npmSpec: "@openclaw/eclaw",
  docsPath: "/channels/eclaw",
});

export const eclawSetupAdapter = optionalSetup.setupAdapter;
export const eclawSetupWizard = optionalSetup.setupWizard;
