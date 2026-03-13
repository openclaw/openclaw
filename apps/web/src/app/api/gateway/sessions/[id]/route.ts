import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { gatewayRpc } from "@/lib/gateway";

export const dynamic = "force-dynamic";

async function requirePaid(userId: string): Promise<boolean> {
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  return sub?.status === "active" && sub.plan !== "free";
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!await requirePaid(session.user.id)) return NextResponse.json({ error: "Upgrade required" }, { status: 403 });

  const { id } = await params;
  try {
    await gatewayRpc("sessions.delete", { id });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!await requirePaid(session.user.id)) return NextResponse.json({ error: "Upgrade required" }, { status: 403 });

  const { id } = await params;
  try {
    const history = await gatewayRpc("chat.history", { sessionId: id });
    return NextResponse.json(history);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
