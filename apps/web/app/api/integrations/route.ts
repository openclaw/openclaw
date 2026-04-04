import { normalizeLockedDenchIntegrations } from "@/lib/integrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json(normalizeLockedDenchIntegrations().state);
}
