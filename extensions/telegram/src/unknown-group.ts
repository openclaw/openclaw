import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-runtime";

/** Default cooldown between warn/leave actions for the same chat. */
export const DEFAULT_UNKNOWN_GROUP_COOLDOWN_MS = 60_000;

/**
 * Returns true when a group policy block reason means the chat is unknown
 * (not in the allowlist / no groups configured), as opposed to a configured
 * group or sender-level rejection.
 */
export function isUnknownGroupPolicyBlock(reason: string): boolean {
  return reason === "group-chat-not-allowed" || reason === "group-policy-allowlist-empty";
}

/** In-memory per-chat cooldown tracker for unknown-group actions. */
export class UnknownGroupCooldownTracker {
  private readonly lastActionAt = new Map<string | number, number>();

  isOnCooldown(chatId: string | number, cooldownMs: number): boolean {
    if (cooldownMs <= 0) {
      return false;
    }
    const last = this.lastActionAt.get(chatId);
    if (last === undefined) {
      return false;
    }
    return Date.now() - last < cooldownMs;
  }

  record(chatId: string | number): void {
    this.lastActionAt.set(chatId, Date.now());
  }
}

/** Resolves the effective unknown-group action configuration. */
export function resolveUnknownGroupConfig(telegramCfg: TelegramAccountConfig): {
  action: "ignore" | "warn" | "leave";
  message: string | undefined;
  cooldownMs: number;
} {
  return {
    action: telegramCfg.unknownGroupAction ?? "ignore",
    message: telegramCfg.unknownGroupMessage,
    cooldownMs: telegramCfg.unknownGroupCooldownMs ?? DEFAULT_UNKNOWN_GROUP_COOLDOWN_MS,
  };
}
