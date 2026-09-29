import { getRootOptionAwareCommandPath } from "openclaw/plugin-sdk/cli-argv";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

// Metadata discovery for unrelated commands must not load the meeting runtime.
const descriptor = {
  name: "slackhuddles",
  description: "Join and manage Slack huddle participants",
  hasSubcommands: true,
  machineOutput: ({ argv }: { argv: readonly string[] }) =>
    getRootOptionAwareCommandPath(argv, 2).length === 2,
} as const;

export const SLACK_HUDDLES_CLI_METADATA = {
  id: "slack-huddles",
  name: "Slack huddles",
  description: "Slack huddles CLI metadata",
  descriptor,
  register(api: OpenClawPluginApi) {
    api.registerCli(() => {}, { descriptors: [descriptor] });
  },
};
