import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REDIRECT_URI = "http://localhost:3000/api/settings/oauth/callback";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { provider } = body as { provider?: string };

  if (!provider) {
    return NextResponse.json({ error: "Provider is required" }, { status: 400 });
  }

  // Chutes OAuth implementation example
  if (provider === "chutes") {
    const state = crypto.randomBytes(16).toString("hex");
    const codeVerifier = crypto.randomBytes(32).toString("hex");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    const cookieStore = await cookies();
    cookieStore.set("oauth_state", state, { httpOnly: true, secure: process.env.NODE_ENV === "production" });
    cookieStore.set("oauth_code_verifier", codeVerifier, { httpOnly: true, secure: process.env.NODE_ENV === "production" });

    const authUrl = new URL("https://chutes.ai/oauth/authorize");
    authUrl.searchParams.set("client_id", "ironclaw-web"); // Placeholder
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("scope", "openid profile email");

    return NextResponse.json({ url: authUrl.toString() });
  }

  return NextResponse.json({ error: "Unsupported OAuth provider" }, { status: 400 });
}
