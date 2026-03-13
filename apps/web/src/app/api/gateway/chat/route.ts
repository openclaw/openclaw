import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { gatewayChatProxy } from "@/lib/gateway";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  let gwRes: Response;
  try {
    gwRes = await gatewayChatProxy(body);
  } catch (err) {
    return NextResponse.json({ error: `Gateway unreachable: ${err}` }, { status: 502 });
  }

  if (!gwRes.ok) {
    const text = await gwRes.text();
    return new NextResponse(text, { status: gwRes.status });
  }

  // Stream the gateway response straight back to the client (SSE or JSON)
  const contentType = gwRes.headers.get("Content-Type") ?? "application/json";
  return new NextResponse(gwRes.body, {
    status: gwRes.status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
