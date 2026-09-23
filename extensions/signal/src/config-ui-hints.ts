import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
// Signal helper module supports config ui hints behavior.
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const signalChannelConfigUiHints = {
  "": {
    label: "Signal",
    help: "Signal channel provider configuration including account identity and DM policy behavior. Keep account mapping explicit so routing remains stable across multi-device setups.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "Signal",
    dmPolicy: { channelKey: "signal" },
    configWrites: true,
  }),
  account: {
    label: "Signal Account",
    help: "Signal account identifier (phone/number handle) used to bind this channel config to a specific Signal identity. Keep this aligned with your linked device/session state.",
    presentation: "phone-number",
  },
  allowFrom: { presentation: "phone-number" },
  defaultTo: { presentation: "phone-number" },
  groupAllowFrom: { presentation: "phone-number" },
  reactionAllowlist: { presentation: "phone-number" },
  "accounts.*.account": { presentation: "phone-number" },
  "accounts.*.allowFrom.*": { presentation: "phone-number" },
  "accounts.*.defaultTo": { presentation: "phone-number" },
  "accounts.*.groupAllowFrom.*": { presentation: "phone-number" },
  "accounts.*.reactionAllowlist.*": { presentation: "phone-number" },
  transport: {
    label: "Signal Transport",
    help: "Account-owned native process or external endpoint configuration. Named accounts do not inherit this value.",
  },
  "transport.kind": {
    label: "Signal Transport Kind",
    help: "Use managed-native to let OpenClaw start signal-cli, external-native for an existing native daemon, or container for signal-cli-rest-api.",
  },
  "transport.configPath": {
    label: "Signal CLI Config Path",
    help: "Optional directory passed to signal-cli via --config when the service needs a non-default signal-cli data path.",
  },
  "transport.socketPath": {
    label: "Signal UNIX Socket Path",
    help: "Opt-in managed-native transport on POSIX. Use an absolute socket path in a private directory owned by the Gateway user (mode 0700). Excludes url, httpHost, httpPort, and receiveMode on-start. HTTP remains the default; socket failures never fall back to HTTP.",
  },
  "transport.url": {
    label: "Signal Transport URL",
    help: "Base URL for an external-native or container transport, or the connection endpoint for a managed-native daemon when it differs from the bind address.",
  },
} satisfies Record<string, ChannelConfigUiHint>;
