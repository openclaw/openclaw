import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { checkCsrf } from "@/lib/csrf";
import { attachRequestIdHeader, ensureRequestId } from "@/lib/errors";
import {
  checkRateLimit,
  RateLimitPresets,
  type RateLimitConfig,
} from "@/lib/rate-limit";
import { getCurrentRiskConfig } from "@/lib/risk-level";
import { requireProfileWorkspaceAccess } from "@/lib/profile-context";

export interface ApiGuardOptions {
  /** Apply in-memory rate limiting */
  rateLimit?: Partial<RateLimitConfig>;
  /** Check CSRF for state-changing routes (opt-in via env flag) */
  requireCsrf?: boolean;
  /**
   * When true, extract the profile from X-Profile-Id header and verify
   * the profile owns the workspace_id found in query params or request body.
   * Backward-compatible: requests without X-Profile-Id are allowed through.
   */
  requireProfile?: boolean;
}

export const ApiGuardPresets = {
  read: { rateLimit: RateLimitPresets.standard, requireCsrf: false, requireProfile: true },
  write: { rateLimit: RateLimitPresets.write, requireCsrf: true, requireProfile: true },
  llm: { rateLimit: RateLimitPresets.llm, requireCsrf: true, requireProfile: true },
  expensive: { rateLimit: RateLimitPresets.expensive, requireCsrf: true, requireProfile: true },
} as const;

const CSRF_ENV_FLAG =
  (
    process.env.MISSION_CONTROL_CSRF_PROTECTION ||
    (process.env.NODE_ENV === "production" ? "true" : "false")
  ).toLowerCase() ===
  "true";

type GuardedHandler = (request: NextRequest) => Promise<Response>;

/**
 * Extract workspace_id from query params (for GET/DELETE) or body cache.
 */
function extractWorkspaceId(request: NextRequest): string | null {
  // Try query params first (works for GET / DELETE)
  const fromQuery = request.nextUrl.searchParams.get("workspace_id");
  if (fromQuery) return fromQuery;

  return null;
}

/**
 * Shared API guard for auth, rate limiting, CSRF checks, and profile
 * workspace authorization.
 * Behavior is modulated by the current risk level.
 */
export function withApiGuard(
  handler: GuardedHandler,
  options: ApiGuardOptions = {}
): GuardedHandler {
  return async (request: NextRequest) => {
    const requestId = ensureRequestId(request.headers.get("x-request-id"));
    const riskConfig = getCurrentRiskConfig();

    // Auth — skip when risk level says auth is not required
    if (riskConfig.authRequired) {
      const authError = requireAuth(request, requestId);
      if (authError) return authError;
    }

    // Rate limit — apply multiplier from risk config
    if (options.rateLimit && isFinite(riskConfig.rateLimitMultiplier)) {
      const adjustedConfig: Partial<RateLimitConfig> = {
        ...options.rateLimit,
      };
      if (adjustedConfig.limit && riskConfig.rateLimitMultiplier !== 1) {
        adjustedConfig.limit = Math.max(
          1,
          Math.round(adjustedConfig.limit * riskConfig.rateLimitMultiplier)
        );
      }
      const rateLimitError = checkRateLimit(request, adjustedConfig, requestId);
      if (rateLimitError) return rateLimitError;
    }

    // CSRF — skip when risk level disables it
    if (options.requireCsrf && CSRF_ENV_FLAG && riskConfig.csrfEnabled) {
      const csrfError = checkCsrf(request, requestId);
      if (csrfError) return csrfError;
    }

    // Profile-workspace authorization
    if (options.requireProfile) {
      const workspaceId = extractWorkspaceId(request);
      const profileError = requireProfileWorkspaceAccess(
        request,
        workspaceId,
        requestId
      );
      if (profileError) return profileError;
    }

    const response = await handler(request);
    return attachRequestIdHeader(response, requestId);
  };
}
