import { readAgentSessions } from "./shared";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(readAgentSessions());
}
