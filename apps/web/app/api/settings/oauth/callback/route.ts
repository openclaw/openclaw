import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { upsertAuthProfile, applyAuthProfileConfig, readConfig, writeConfig } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  const cookieStore = await cookies();
  const savedState = cookieStore.get("oauth_state")?.value;
  const codeVerifier = cookieStore.get("oauth_code_verifier")?.value;

  if (!code || !state || state !== savedState || !codeVerifier) {
    return new NextResponse("Invalid OAuth state or code verifier", { status: 400 });
  }

  try {
    // Exchange code for tokens (Placeholder for Chutes)
    const tokenRes = await fetch("https://chutes.ai/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "ironclaw-web",
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:3000/api/settings/oauth/callback",
        code_verifier: codeVerifier,
      }),
    });

    if (!tokenRes.ok) {
      const error = await tokenRes.text();
      return new NextResponse(`Token exchange failed: ${error}`, { status: 500 });
    }

    const tokens = await tokenRes.json();
    const profileId = "chutes:default";

    // Store in credentials.json
    upsertAuthProfile({
      profileId,
      credential: {
        type: "oauth",
        provider: "chutes",
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
      },
    });

    // Update openclaw.json
    const config = readConfig();
    const updatedConfig = applyAuthProfileConfig(config, {
      profileId,
      provider: "chutes",
      mode: "oauth",
    });
    writeConfig(updatedConfig);

    // Return success HTML that notifies the parent window
    return new NextResponse(
      `<html>
        <body>
          <script>
            window.opener.postMessage({ type: 'oauth-success', provider: 'chutes' }, '*');
            window.close();
          </script>
          <h1>Success! You can close this window.</h1>
        </body>
      </html>`,
      { headers: { "Content-Type": "text/html" } }
    );
  } catch (err) {
    return new NextResponse(`OAuth callback failed: ${String(err)}`, { status: 500 });
  }
}
