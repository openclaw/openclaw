/**
 * Convos setup — creates a conversation via the CLI, returns invite URL.
 * Config is NOT written here; the caller persists config after join is confirmed.
 */

import type { ConvosSetupResult } from "./types.js";
import { resolveConvosAccount, type CoreConfig } from "./accounts.js";
import { getConvosRuntime } from "./runtime.js";
import { ConvosInstance, type ConvosInstanceOptions } from "./sdk-client.js";

export type SetupConvosParams = {
  accountId?: string;
  env?: "production" | "dev";
  name?: string;
};

export type SetupConvosResultWithClient = ConvosSetupResult & {
  instance?: ConvosInstance;
};

/**
 * Setup Convos by creating a conversation via the CLI.
 * Returns an invite URL that can be displayed as a QR code.
 *
 * Does NOT write config — the caller should persist config after the user
 * has successfully joined the conversation.
 */
export async function setupConvosWithInvite(
  params: SetupConvosParams,
  options?: ConvosInstanceOptions,
): Promise<SetupConvosResultWithClient> {
  const runtime = getConvosRuntime();
  const cfg = runtime.config.loadConfig();
  const account = resolveConvosAccount({ cfg: cfg as CoreConfig, accountId: params.accountId });
  const env = params.env ?? account.env;
  const name = params.name ?? "OpenClaw";

  // Shell out to: convos conversations create --name "..." --profile-name "..." --json
  const { instance, result } = await ConvosInstance.create(
    env,
    { name, profileName: name },
    options,
  );

  return {
    inviteUrl: result.inviteUrl,
    conversationId: result.conversationId,
    identityId: instance.identityId,
    instance,
  };
}
