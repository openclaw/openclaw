export interface PermissionConfig {
  ownerTelegramIds: number[];
  allowedTelegramIds: number[];
  rateLimits: { maxRequestsPerMinute: number; maxTokensPerDay: number };
  autoApprove: string[];
  requireConfirm: string[];
  deny: string[];
}

const DEFAULT_CONFIG: PermissionConfig = {
  ownerTelegramIds: [],
  allowedTelegramIds: [],
  rateLimits: { maxRequestsPerMinute: 30, maxTokensPerDay: 500_000 },
  autoApprove: ["read:*", "analyze:*"],
  requireConfirm: ["git:push", "deploy:*", "delete:*"],
  deny: ["system:rm-rf", "deploy:production-auto"],
};

const requestCounts = new Map<number, { count: number; resetAt: number }>();

export function isAllowedUser(userId: number, config = DEFAULT_CONFIG): boolean {
  if (config.ownerTelegramIds.includes(userId)) return true;
  if (config.allowedTelegramIds.length === 0) return true;
  return config.allowedTelegramIds.includes(userId);
}

export function checkRateLimit(userId: number, config = DEFAULT_CONFIG): boolean {
  const now = Date.now();
  let entry = requestCounts.get(userId);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 };
    requestCounts.set(userId, entry);
  }
  entry.count++;
  return entry.count <= config.rateLimits.maxRequestsPerMinute;
}

export function matchesPattern(action: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === action) return true;
    if (pattern.endsWith(":*")) {
      const prefix = pattern.slice(0, -1);
      if (action.startsWith(prefix)) return true;
    }
  }
  return false;
}

export function getActionPermission(
  action: string,
  config = DEFAULT_CONFIG,
): "allow" | "confirm" | "deny" {
  if (matchesPattern(action, config.deny)) return "deny";
  if (matchesPattern(action, config.requireConfirm)) return "confirm";
  if (matchesPattern(action, config.autoApprove)) return "allow";
  return "confirm";
}
