import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { gatewayRpc } from "@/lib/gateway";

export const dynamic = "force-dynamic";

interface ConfigSnapshot {
  config?: Record<string, unknown>;
  hash?: string;
  raw?: string;
  valid?: boolean;
}

/** GET /api/gateway/config — returns the current gateway config + base hash */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const snapshot = await gatewayRpc<ConfigSnapshot>("config.get");
    return NextResponse.json(snapshot);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

/**
 * PATCH /api/gateway/config — merge-patch a partial config into the gateway.
 * Body: { patch: Record<string, unknown>, baseHash: string }
 * The `patch` is sent as a JSON string (the gateway's config.patch `raw` param).
 */
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if ((session.user as { role?: string }).role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { patch: unknown; baseHash: string };
  if (!body.patch || typeof body.baseHash !== "string") {
    return NextResponse.json({ error: "patch and baseHash required" }, { status: 400 });
  }

  try {
    const result = await gatewayRpc("config.patch", {
      raw: JSON.stringify(body.patch),
      baseHash: body.baseHash,
    });
    return NextResponse.json(result ?? { ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
