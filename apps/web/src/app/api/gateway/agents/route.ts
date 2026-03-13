import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { gatewayRpc, GatewayAgent } from "@/lib/gateway";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const agents = await gatewayRpc<GatewayAgent[]>("agents.list");
    return NextResponse.json(agents ?? []);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  try {
    const agent = await gatewayRpc<GatewayAgent>("agents.create", body);
    return NextResponse.json(agent);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
