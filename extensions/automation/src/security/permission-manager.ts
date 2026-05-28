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

function parseTelegramIdList(raw: string | undefined): number[] {
  if (!raw) {
    return [];
  }
  return [
    ...new Set(
      raw
        .split(/[,\s;|]+/)
        .map((item) => Number(item.trim()))
        .filter((id) => Number.isFinite(id) && id > 0),
    ),
  ];
}

function toPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : undefined;
}

export function loadPermissionConfigFromEnv(base = DEFAULT_CONFIG): PermissionConfig {
  const ownerTelegramIds = parseTelegramIdList(process.env.OPENCLAW_TELEGRAM_OWNER_IDS);
  const allowedTelegramIds = parseTelegramIdList(process.env.OPENCLAW_TELEGRAM_ALLOWED_IDS);
  const maxRequestsPerMinute = toPositiveInt(process.env.OPENCLAW_TELEGRAM_RATE_LIMIT_PER_MINUTE);
  const maxTokensPerDay = toPositiveInt(process.env.OPENCLAW_TELEGRAM_RATE_LIMIT_TOKENS_PER_DAY);
  return {
    ...base,
    ownerTelegramIds: ownerTelegramIds.length > 0 ? ownerTelegramIds : base.ownerTelegramIds,
    allowedTelegramIds:
      allowedTelegramIds.length > 0 ? allowedTelegramIds : base.allowedTelegramIds,
    rateLimits: {
      maxRequestsPerMinute: maxRequestsPerMinute ?? base.rateLimits.maxRequestsPerMinute,
      maxTokensPerDay: maxTokensPerDay ?? base.rateLimits.maxTokensPerDay,
    },
  };
}

export function isOwnerUser(userId: number, config = DEFAULT_CONFIG): boolean {
  return config.ownerTelegramIds.includes(userId);
}

export function isAllowedUser(userId: number, config = DEFAULT_CONFIG): boolean {
  if (config.ownerTelegramIds.includes(userId)) {
    return true;
  }
  if (config.allowedTelegramIds.length === 0) {
    return true;
  }
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
    if (pattern === action) {
      return true;
    }
    if (pattern.endsWith(":*")) {
      const prefix = pattern.slice(0, -1);
      if (action.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

export function getActionPermission(
  action: string,
  config = DEFAULT_CONFIG,
): "allow" | "confirm" | "deny" {
  if (matchesPattern(action, config.deny)) {
    return "deny";
  }
  if (matchesPattern(action, config.requireConfirm)) {
    return "confirm";
  }
  if (matchesPattern(action, config.autoApprove)) {
    return "allow";
  }
  return "confirm";
}
