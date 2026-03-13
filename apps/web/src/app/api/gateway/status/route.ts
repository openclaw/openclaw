import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { gatewayHealth, gatewayRpc, GatewayAgent, GatewaySession } from "@/lib/gateway";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [health, agents, sessions] = await Promise.allSettled([
    gatewayHealth(),
    gatewayRpc<GatewayAgent[]>("agents.list"),
    gatewayRpc<GatewaySession[]>("sessions.list"),
  ]);

  const online = health.status === "fulfilled" && health.value.online;

  return NextResponse.json({
    online,
    status: health.status === "fulfilled" ? health.value.status : undefined,
    agentCount: agents.status === "fulfilled" ? (agents.value?.length ?? 0) : null,
    sessionCount: sessions.status === "fulfilled" ? (sessions.value?.length ?? 0) : null,
  });
}
