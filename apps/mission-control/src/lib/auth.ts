import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, attachRequestIdHeader } from "@/lib/errors";

/**
 * Simple API key authentication middleware.
 * Set MISSION_CONTROL_API_KEY environment variable to enable.
 * 
 * For production, consider:
 * - Session-based auth with cookies
 * - OAuth/OIDC integration
 * - JWT tokens with proper expiration
 */

const EXPLICIT_API_KEY = process.env.MISSION_CONTROL_API_KEY;
const USE_GATEWAY_TOKEN =
  (process.env.MISSION_CONTROL_USE_GATEWAY_TOKEN_FOR_API_AUTH || "false")
    .toLowerCase() === "true";
const API_KEY = EXPLICIT_API_KEY || (USE_GATEWAY_TOKEN ? process.env.OPENCLAW_AUTH_TOKEN : undefined);
const REQUIRE_AUTH_BY_DEFAULT = process.env.NODE_ENV === "production";
const AUTH_ENABLED = REQUIRE_AUTH_BY_DEFAULT || !!API_KEY;
const AUTH_COOKIE_NAME = process.env.MISSION_CONTROL_AUTH_COOKIE_NAME || "mc_api_auth";

if (!AUTH_ENABLED) {
  console.warn(
    "[auth] WARNING: Authentication is DISABLED. " +
    "Set MISSION_CONTROL_API_KEY or NODE_ENV=production to enable.",
  );
}

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) {return null;}
  const value = authHeader.trim();
  if (!value.toLowerCase().startsWith("bearer ")) {return null;}
  return value.slice(7).trim();
}

function extractQueryToken(request: NextRequest): string | null {
  const pathname = request.nextUrl.pathname;
  if (request.method.toUpperCase() !== "GET") {return null;}
  if (pathname !== "/api/openclaw/events") {return null;}
  const token = request.nextUrl.searchParams.get("token");
  return token?.trim() || null;
}

export function requireAuth(
  request: NextRequest,
  requestId?: string
): NextResponse | null {
  if (!AUTH_ENABLED) {
    // Auth disabled - allow all requests (dev mode)
    return null;
  }

  if (!API_KEY) {
    return apiErrorResponse({
      message:
        "Server auth is enabled but no API key is configured. Set MISSION_CONTROL_API_KEY.",
      status: 503,
      code: "AUTH_MISCONFIGURED",
      requestId,
    });
  }

  const apiKey =
    extractBearerToken(request.headers.get("Authorization")) ||
    request.headers.get("x-api-key") ||
    request.headers.get("x-openclaw-auth") ||
    request.cookies.get(AUTH_COOKIE_NAME)?.value ||
    extractQueryToken(request);

  if (!apiKey || apiKey !== API_KEY) {
    return apiErrorResponse({
      message: "Unauthorized",
      status: 401,
      code: "UNAUTHORIZED",
      requestId,
    });
  }

  return null; // Auth passed
}

/**
 * Wrap an API handler with authentication.
 * Usage:
 *   export const GET = withAuth(async (request) => { ... });
 */
export function withAuth(
  handler: (request: NextRequest) => Promise<NextResponse>
): (request: NextRequest) => Promise<NextResponse> {
  return async (request: NextRequest) => {
    const requestId = request.headers.get("x-request-id") ?? undefined;
    const authError = requireAuth(request, requestId);
    if (authError) {return authError;}
    const response = await handler(request);
    return attachRequestIdHeader(response, requestId);
  };
}
