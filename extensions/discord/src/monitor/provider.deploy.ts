import { warn, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import type { Client } from "../internal/discord.js";
import {
  formatDiscordDeployErrorDetails,
  formatDiscordDeployErrorMessage,
  formatDiscordDeployRateLimitWarning,
  isDiscordDeployDailyCreateLimit,
} from "./provider.deploy-errors.js";

export function runDiscordCommandDeployInBackground(params: {
  client: Client;
  runtime: RuntimeEnv;
  enabled: boolean;
  accountId: string;
}) {
  if (!params.enabled) {
    return;
  }
  async function deployDiscordCommands() {
    const { accountId } = params;
    try {
      await params.client.deployCommands();
    } catch (err) {
      if (isDiscordDeployDailyCreateLimit(err)) {
        params.runtime.log?.(
          warn(
            `[${accountId}] slash command deploy skipped: daily application command create limit reached. Existing slash commands stay active until Discord resets the quota; message send/receive is unaffected.`,
          ),
        );
        return;
      }
      const rateLimitWarning = formatDiscordDeployRateLimitWarning(err, accountId);
      if (rateLimitWarning) {
        params.runtime.log?.(warn(rateLimitWarning));
        return;
      }
      params.runtime.log?.(
        warn(
          `[${accountId}] slash command deploy failed (message send/receive unaffected): ${formatDiscordDeployErrorMessage(err)}${formatDiscordDeployErrorDetails(err)}`,
        ),
      );
    }
  }
  void deployDiscordCommands().catch((err: unknown) => {
    params.runtime.log?.(
      warn(
        `[${params.accountId}] slash command deploy failed in background (message send/receive unaffected): ${formatErrorMessage(err)}`,
      ),
    );
  });
}
