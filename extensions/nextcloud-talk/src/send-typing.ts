import { resolveNextcloudTalkAccount } from "./accounts.js";
import { stripNextcloudTalkTargetPrefix } from "./normalize.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { generateNextcloudTalkSignature } from "./signature.js";
import type { CoreConfig } from "./types.js";

type NextcloudTalkTypingOpts = {
  baseUrl?: string;
  secret?: string;
  accountId?: string;
  cfg?: CoreConfig;
};

/**
 * Send a typing indicator to a Nextcloud Talk room.
 *
 * Uses the bot typing endpoint: POST /ocs/v2.php/apps/spreed/api/v1/bot/{token}/typing
 * Authentication follows the same HMAC-SHA256 pattern as sendMessageNextcloudTalk.
 *
 * Gracefully handles:
 * - 404: endpoint not available on this Nextcloud version (logs warning, continues)
 * - Network errors: logs warning, does not throw
 *
 * @param roomToken - Room token or "room:<token>" prefixed string.
 * @param typing - true to start typing, false to stop.
 * @param opts - Optional credentials/config override.
 * @returns true if the signal was sent successfully, false otherwise.
 */
export async function sendTypingNextcloudTalk(
  roomToken: string,
  typing: boolean,
  opts: NextcloudTalkTypingOpts = {},
): Promise<boolean> {
  let baseUrl: string;
  let secret: string;

  try {
    const cfg = (opts.cfg ?? getNextcloudTalkRuntime().config.loadConfig()) as CoreConfig;
    const account = resolveNextcloudTalkAccount({
      cfg,
      accountId: opts.accountId,
    });
    baseUrl = opts.baseUrl?.trim() ?? account.baseUrl;
    secret = opts.secret?.trim() ?? account.secret;

    if (!baseUrl || !secret) {
      return false;
    }
  } catch {
    return false;
  }

  const normalizedToken = stripNextcloudTalkTargetPrefix(roomToken);
  if (!normalizedToken) {
    return false;
  }

  const body = JSON.stringify({ typing });

  // Sign the JSON body (same pattern as sendMessageNextcloudTalk signs the message text)
  const { random, signature } = generateNextcloudTalkSignature({
    body,
    secret,
  });

  const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/bot/${normalizedToken}/typing`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "OCS-APIRequest": "true",
        "X-Nextcloud-Talk-Bot-Random": random,
        "X-Nextcloud-Talk-Bot-Signature": signature,
      },
      body,
    });

    if (response.status === 404) {
      // Endpoint not available on this Nextcloud version — log once and continue
      console.warn(
        `[nextcloud-talk] Typing indicator not supported by server (404). ` +
          `Upgrade to Nextcloud Talk with bot typing support to enable this feature.`,
      );
      return false;
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      console.warn(
        `[nextcloud-talk] Typing indicator failed (${response.status}): ${errorBody}`.trim(),
      );
      return false;
    }

    return true;
  } catch (err) {
    console.warn(`[nextcloud-talk] Typing indicator request failed: ${String(err)}`);
    return false;
  }
}

/**
 * Resolve whether typing indicators are enabled for a given room and account.
 * Room-level config takes precedence over account-level config.
 * Default: false (opt-in).
 */
export function resolveTypingIndicatorEnabled(params: {
  accountTypingIndicator?: boolean;
  roomTypingIndicator?: boolean;
}): boolean {
  const { accountTypingIndicator, roomTypingIndicator } = params;
  // Room-level override takes precedence
  if (typeof roomTypingIndicator === "boolean") {
    return roomTypingIndicator;
  }
  // Fall back to account-level
  return accountTypingIndicator === true;
}
