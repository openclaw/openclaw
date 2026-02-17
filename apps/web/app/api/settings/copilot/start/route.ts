import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CLIENT_ID = "Iv1.b507a3d255788057"; // GitHub Copilot CLI Client ID

export async function POST() {
  try {
    const res = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        scope: "read:user",
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      return NextResponse.json({ error: `Failed to start device flow: ${error}` }, { status: 500 });
    }

    const data = await res.json();
    // data: { device_code, user_code, verification_uri, expires_in, interval }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: `Failed to start Copilot flow: ${String(err)}` }, { status: 500 });
  }
}
