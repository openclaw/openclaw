import { resolveActiveAgentId } from "@/lib/workspace";
import { readGatewaySessionsForAgent, listAllAgentIds } from "@/lib/gateway-transcript";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const channelFilter = url.searchParams.get("channel");
  const activeAgentId = resolveActiveAgentId();

  const agentIds = listAllAgentIds();
  const prioritized = [activeAgentId, ...agentIds.filter((id) => id !== activeAgentId)];

  let sessions = prioritized.flatMap((agentId) => readGatewaySessionsForAgent(agentId));

  const seen = new Set<string>();
  sessions = sessions.filter((s) => {
    if (seen.has(s.sessionKey)) return false;
    seen.add(s.sessionKey);
    return true;
  });

  if (channelFilter) {
    sessions = sessions.filter((s) => s.channel === channelFilter);
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt);

  return Response.json({ sessions });
}
