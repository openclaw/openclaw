/**
 * Convos setup - creates XMTP identity and conversation, returns invite URL
 */

import { resolveConvosAccount, type CoreConfig } from "./accounts.js";
import { getConvosRuntime } from "./runtime.js";
import { ConvosSDKClient } from "./sdk-client.js";
import type { ConvosSetupResult } from "./types.js";

export type SetupConvosParams = {
  accountId?: string;
  env?: "production" | "dev";
  name?: string;
};

/**
 * Setup Convos by creating an XMTP identity and owner conversation.
 * Returns an invite URL that can be displayed as a QR code.
 */
export async function setupConvosWithInvite(
  params: SetupConvosParams,
): Promise<ConvosSetupResult> {
  const runtime = getConvosRuntime();
  const cfg = runtime?.config.load() ?? {};
  const account = resolveConvosAccount({
    cfg: cfg as CoreConfig,
    accountId: params.accountId,
  });

  // Create SDK client (generates new identity if no privateKey)
  const client = await ConvosSDKClient.create({
    privateKey: account.privateKey,
    env: params.env ?? account.env,
    debug: false,
  });

  try {
    // Start the agent to enable conversation creation
    await client.start();

    // Create a new conversation (this will be the owner conversation)
    const conversationName = params.name ?? "OpenClaw";
    const result = await client.createConversation(conversationName);

    // Stop the temporary client
    await client.stop();

    const privateKey = client.getPrivateKey();

    // Save config with new identity and owner conversation
    const newConfig = {
      ...cfg,
      channels: {
        ...(cfg as CoreConfig).channels,
        convos: {
          ...((cfg as CoreConfig).channels?.convos ?? {}),
          enabled: true,
          privateKey,
          env: params.env ?? account.env ?? "production",
          ownerConversationId: result.conversationId,
        },
      },
    };

    await runtime?.config.write(newConfig);

    return {
      inviteUrl: result.inviteUrl,
      conversationId: result.conversationId,
      privateKey,
    };
  } catch (err) {
    await client.stop();
    throw err;
  }
}
