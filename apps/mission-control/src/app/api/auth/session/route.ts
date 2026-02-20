import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/auth/session — Verify API key and set httpOnly auth cookie.
 * DELETE /api/auth/session — Clear the auth cookie (logout).
 *
 * This allows the browser to authenticate SSE (EventSource) and other
 * requests without storing the raw token in localStorage.
 */

const API_KEY =
  process.env.MISSION_CONTROL_API_KEY ||
  (process.env.MISSION_CONTROL_USE_GATEWAY_TOKEN_FOR_API_AUTH === "true"
    ? process.env.OPENCLAW_AUTH_TOKEN
    : undefined);

const AUTH_COOKIE_NAME =
  process.env.MISSION_CONTROL_AUTH_COOKIE_NAME || "mc_api_auth";

const IS_PRODUCTION = process.env.NODE_ENV === "production";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token.trim() : "";

  if (!token) {
    return NextResponse.json(
      { error: "Token is required" },
      { status: 400 }
    );
  }

  // If no server-side key is configured, accept any non-empty token in dev
  if (API_KEY && token !== API_KEY) {
    return NextResponse.json(
      { error: "Invalid token" },
      { status: 401 }
    );
  }

  const response = NextResponse.json({ ok: true });

  response.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });

  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });

  response.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });

  return response;
}
