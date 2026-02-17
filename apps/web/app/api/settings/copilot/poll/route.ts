import { NextRequest, NextResponse } from "next/server";
import { upsertAuthProfile, applyAuthProfileConfig, readConfig, writeConfig } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CLIENT_ID = "Iv1.b507a3d255788057";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { device_code } = body as { device_code?: string };

    if (!device_code) {
      return NextResponse.json({ error: "device_code is required" }, { status: 400 });
    }

    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      return NextResponse.json({ error: `Polling failed: ${error}` }, { status: 500 });
    }

    const data = await res.json();

    if (data.error) {
      // data.error: authorization_pending, slow_down, expired_token, access_denied
      return NextResponse.json(data);
    }

    if (data.access_token) {
      const profileId = "github-copilot:default";

      // Store in credentials.json
      upsertAuthProfile({
        profileId,
        credential: {
          type: "oauth", // CLI marks it as oauth
          provider: "github-copilot",
          accessToken: data.access_token,
        },
      });

      // Update openclaw.json
      const config = readConfig();
      const updatedConfig = applyAuthProfileConfig(config, {
        profileId,
        provider: "github-copilot",
        mode: "oauth",
      });
      writeConfig(updatedConfig);

      return NextResponse.json({ ok: true, profileId });
    }

    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: `Polling failed: ${String(err)}` }, { status: 500 });
  }
}
