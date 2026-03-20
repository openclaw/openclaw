import crypto from "node:crypto";
import type { HyperionDynamoDBClient } from "./dynamodb-client.js";
import {
  DEFAULT_AGENT_ID,
  type ChannelLink,
  type ChannelRuntimeConfig,
  type HyperionPlatform,
  type PairingCode,
} from "./types.js";

const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_TTL_SECONDS = 5 * 60; // 5 minutes

/**
 * DynamoDB-backed pairing store for Hyperion.
 *
 * Replaces OpenClaw's file-based pairing store (src/pairing/pairing-store.ts) with
 * a serverless implementation using the pairing_codes DynamoDB table.
 *
 * Flow:
 *   1. User clicks "Connect Telegram" in portal → generatePairingCode()
 *   2. User sends `/connect <CODE>` to bot on Telegram → redeemPairingCode()
 *   3. Code is validated, channel link is created, code is deleted
 *
 * Key differences from OpenClaw's file-based store:
 *   - No file locks needed — DynamoDB provides atomic conditional writes
 *   - No pruning needed — DynamoDB TTL auto-deletes expired codes
 *   - No max-pending limit needed — TTL-based expiry prevents unbounded growth
 *   - Pairing is user-initiated (portal → external), not external-initiated
 */
export class HyperionPairingStore {
  private readonly dbClient: HyperionDynamoDBClient;

  constructor(dbClient: HyperionDynamoDBClient) {
    this.dbClient = dbClient;
  }

  /**
   * Generate a pairing code for a user to connect a specific channel.
   * Called from the portal when user clicks "Connect <Platform>".
   *
   * @returns The generated code, or null if code generation failed after retries.
   */
  // [claude-infra] Multi-instance: agentId specifies which agent the channel binds to.
  async generatePairingCode(
    userId: string,
    platform: HyperionPlatform,
    agentId: string = DEFAULT_AGENT_ID,
    meta?: Record<string, string>,
  ): Promise<string | null> {
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const code = randomCode();
      const pairingCode: PairingCode = {
        code,
        user_id: userId,
        agent_id: agentId,
        platform,
        created_at: new Date().toISOString(),
        expires_at: Math.floor(Date.now() / 1000) + PAIRING_CODE_TTL_SECONDS,
        ...(meta ? { meta } : {}),
      };

      try {
        await this.dbClient.putPairingCode(pairingCode);
        return code;
      } catch (err) {
        // ConditionalCheckFailedException means code already exists — retry.
        if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
          continue;
        }
        throw err;
      }
    }
    return null;
  }

  /**
   * Redeem a pairing code and create the channel link.
   * Called when a webhook arrives with `/connect <CODE>`.
   *
   * @returns The created ChannelLink, or null if the code is invalid/expired.
   */
  async redeemPairingCode(params: {
    code: string;
    platform: HyperionPlatform;
    platformUserId: string;
    channelAccountId?: string;
    channelConfig?: ChannelRuntimeConfig;
  }): Promise<ChannelLink | null> {
    const normalizedCode = params.code.trim().toUpperCase();
    if (!normalizedCode) {
      return null;
    }

    // Atomically consume the pairing code — conditional delete ensures only one
    // concurrent redeem succeeds, preventing double-bind race conditions.
    const pairingCode = await this.dbClient.consumePairingCode(normalizedCode);
    if (!pairingCode) {
      return null;
    }

    // Verify platform matches.
    if (pairingCode.platform !== params.platform) {
      return null;
    }

    // [claude-infra] Multi-instance: channel link inherits agent_id from pairing code.
    const channelLink: ChannelLink = {
      platform: params.platform,
      platform_user_id: params.platformUserId,
      user_id: pairingCode.user_id,
      agent_id: pairingCode.agent_id || DEFAULT_AGENT_ID,
      paired_at: new Date().toISOString(),
      channel_account_id: params.channelAccountId ?? "default",
      channel_config: params.channelConfig ?? {},
    };

    await this.dbClient.putChannelLink(channelLink);

    return channelLink;
  }

  /**
   * Validate a pairing code without consuming it.
   * Useful for showing confirmation before completing pairing.
   */
  async validatePairingCode(code: string, platform: HyperionPlatform): Promise<PairingCode | null> {
    const normalizedCode = code.trim().toUpperCase();
    if (!normalizedCode) {
      return null;
    }

    const pairingCode = await this.dbClient.getPairingCode(normalizedCode);
    if (!pairingCode) {
      return null;
    }
    if (pairingCode.platform !== platform) {
      return null;
    }

    return pairingCode;
  }

  /**
   * Disconnect a channel link.
   * Called from the portal when user clicks "Disconnect <Platform>".
   */
  async disconnectChannel(platform: HyperionPlatform, platformUserId: string): Promise<void> {
    await this.dbClient.deleteChannelLink(platform, platformUserId);
  }
}

function randomCode(): string {
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    const idx = crypto.randomInt(0, PAIRING_CODE_ALPHABET.length);
    out += PAIRING_CODE_ALPHABET[idx];
  }
  return out;
}
