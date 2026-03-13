import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { gatewayRpc } from "@/lib/gateway";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  try {
    await gatewayRpc("agents.delete", { id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json();
  try {
    const agent = await gatewayRpc("agents.update", { id, ...body });
    return NextResponse.json(agent);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
