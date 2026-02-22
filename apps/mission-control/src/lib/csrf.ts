import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHmac } from "crypto";
import { apiErrorResponse } from "@/lib/errors";

/**
 * CSRF protection utilities.
 * 
 * For SPA applications using fetch(), the double-submit cookie pattern
 * combined with SameSite cookies provides good protection.
 */

const CSRF_SECRET = process.env.CSRF_SECRET || randomBytes(32).toString("hex");
const CSRF_COOKIE_NAME = "mc_csrf";
const CSRF_HEADER_NAME = "x-csrf-token";

/**
 * Generate a CSRF token.
 */
export function generateCsrfToken(): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(16).toString("hex");
  const data = `${timestamp}.${random}`;
  const hmac = createHmac("sha256", CSRF_SECRET).update(data).digest("hex");
  return `${data}.${hmac.slice(0, 16)}`;
}

/**
 * Validate a CSRF token.
 */
export function validateCsrfToken(token: string): boolean {
  if (!token) {return false;}
  
  const parts = token.split(".");
  if (parts.length !== 3) {return false;}
  
  const [timestamp, random, providedHmac] = parts;
  const data = `${timestamp}.${random}`;
  const expectedHmac = createHmac("sha256", CSRF_SECRET).update(data).digest("hex").slice(0, 16);
  
  // Timing-safe comparison
  if (providedHmac.length !== expectedHmac.length) {return false;}
  
  let result = 0;
  for (let i = 0; i < providedHmac.length; i++) {
    result |= providedHmac.charCodeAt(i) ^ expectedHmac.charCodeAt(i);
  }
  
  if (result !== 0) {return false;}
  
  // Check token age (max 4 hours)
  const tokenTime = parseInt(timestamp, 36);
  const maxAge = 4 * 60 * 60 * 1000;
  if (Date.now() - tokenTime > maxAge) {return false;}
  
  return true;
}

/**
 * Middleware to check CSRF token on mutation requests.
 * Returns error response if invalid, null if valid.
 */
export function checkCsrf(
  request: NextRequest,
  requestId?: string
): NextResponse | null {
  // Only check mutation methods
  const method = request.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    return null;
  }

  // Allow same-origin browser requests based on Origin/Host.
  // This keeps browser UX smooth while still blocking cross-site posts.
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host === host) {
        return null;
      }
    } catch {
      // Fall through to token-based validation.
    }
  }
  
  // Get token from header
  const headerToken = request.headers.get(CSRF_HEADER_NAME);
  
  // Get token from cookie for double-submit validation
  const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value;
  
  // Both must be present and match
  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return apiErrorResponse({
      message: "Invalid or missing CSRF token",
      status: 403,
      code: "CSRF_INVALID",
      requestId,
    });
  }
  
  // Validate token signature
  if (!validateCsrfToken(headerToken)) {
    return apiErrorResponse({
      message: "CSRF token expired or invalid",
      status: 403,
      code: "CSRF_EXPIRED",
      requestId,
    });
  }
  
  return null;
}

/**
 * Create a response with CSRF cookie set.
 * Call this on initial page load or GET /api/csrf-token.
 */
export function setCsrfCookie(response: NextResponse): NextResponse {
  const token = generateCsrfToken();
  
  response.cookies.set(CSRF_COOKIE_NAME, token, {
    httpOnly: false, // Must be readable by JS
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 4 * 60 * 60, // 4 hours
  });
  
  return response;
}
