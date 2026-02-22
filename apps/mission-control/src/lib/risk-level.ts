/**
 * Risk-Level Configuration
 *
 * A single "operational posture" setting that tunes the entire security stack.
 * Each level adjusts: auth, CSRF, rate limiting, agent autonomy, approval gates,
 * activity logging, and agent timeout.
 *
 * Levels:
 *   low     – Maximum caution. Everything locked down.
 *   medium  – Balanced. Auth + CSRF enforced, reasonable limits. (DEFAULT)
 *   high    – Relaxed. For trusted environments.
 *   insane  – Almost no guardrails. For development/testing.
 *   freedom – All protections disabled. Not recommended.
 */

// --- Types ---

export type RiskLevel = "low" | "medium" | "high" | "insane" | "freedom";

export interface RiskConfig {
    /** Whether API key / auth token is required on requests */
    authRequired: boolean;
    /** Whether CSRF double-submit is enforced */
    csrfEnabled: boolean;
    /** Multiplier applied to the base rate limit (1.0 = 60 req/min) */
    rateLimitMultiplier: number;
    /** Whether tasks can be auto-dispatched to agents without manual trigger */
    autoDispatch: boolean;
    /** Approval mode for agent tool execution */
    approvalMode: "all" | "dangerous" | "none";
    /** Whether activity is written to the activity_log table */
    activityLogging: boolean;
    /** Agent task timeout in milliseconds */
    agentTimeoutMs: number;
}

// --- Config Presets ---

const RISK_CONFIGS: Record<RiskLevel, RiskConfig> = {
    low: {
        authRequired: true,
        csrfEnabled: true,
        rateLimitMultiplier: 0.17, // ~10 req/min
        autoDispatch: false,
        approvalMode: "all",
        activityLogging: true,
        agentTimeoutMs: 3 * 60 * 1000, // 3 minutes
    },
    medium: {
        authRequired: true,
        csrfEnabled: true,
        rateLimitMultiplier: 1.0, // 60 req/min
        autoDispatch: false,
        approvalMode: "dangerous",
        activityLogging: true,
        agentTimeoutMs: 5 * 60 * 1000, // 5 minutes
    },
    high: {
        authRequired: false,
        csrfEnabled: true,
        rateLimitMultiplier: 3.33, // ~200 req/min
        autoDispatch: true,
        approvalMode: "dangerous",
        activityLogging: true,
        agentTimeoutMs: 15 * 60 * 1000, // 15 minutes
    },
    insane: {
        authRequired: false,
        csrfEnabled: false,
        rateLimitMultiplier: Infinity, // No limit
        autoDispatch: true,
        approvalMode: "none",
        activityLogging: true,
        agentTimeoutMs: 30 * 60 * 1000, // 30 minutes
    },
    freedom: {
        authRequired: false,
        csrfEnabled: false,
        rateLimitMultiplier: Infinity,
        autoDispatch: true,
        approvalMode: "none",
        activityLogging: false,
        agentTimeoutMs: Infinity, // No timeout
    },
};

const VALID_LEVELS: ReadonlySet<string> = new Set<string>(
    Object.keys(RISK_CONFIGS)
);

// --- Helpers ---

function isValidRiskLevel(value: unknown): value is RiskLevel {
    return typeof value === "string" && VALID_LEVELS.has(value);
}

// --- Public API ---

/**
 * Get the RiskConfig for a given level.
 */
export function getRiskConfig(level: RiskLevel): RiskConfig {
    return RISK_CONFIGS[level];
}

/**
 * Read the current risk level from the database settings table.
 * Falls back to `RISK_LEVEL` env var, then to "medium".
 *
 * Uses lazy require() to avoid circular import with db.ts.
 */
export function getCurrentRiskLevel(): RiskLevel {
    // Env override takes highest priority (useful for CI, staging)
    const envLevel = process.env.RISK_LEVEL;
    if (isValidRiskLevel(envLevel)) {return envLevel;}

    // Try reading from DB settings
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getSetting } = require("./db") as {
            getSetting: (key: string) => string | undefined;
        };
        const dbLevel = getSetting("risk_level");
        if (isValidRiskLevel(dbLevel)) {return dbLevel;}
    } catch {
        // DB not available yet (startup, build-time) — fall through
    }

    return "medium";
}

/**
 * Get the full config for the currently-active risk level.
 */
export function getCurrentRiskConfig(): RiskConfig {
    return getRiskConfig(getCurrentRiskLevel());
}

/**
 * Validate that a value is a valid risk level string. Type guard.
 */
export { isValidRiskLevel };

/**
 * All available risk levels, ordered from most restrictive to least.
 */
export const RISK_LEVELS: readonly RiskLevel[] = [
    "low",
    "medium",
    "high",
    "insane",
    "freedom",
] as const;
