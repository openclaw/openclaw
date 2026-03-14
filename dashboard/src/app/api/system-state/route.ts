import path from "path";
import { getWorkspacePath, readJsonFile, apiResponse } from "@/lib/workspace";
import type { ServiceStatus } from "@/lib/types";

export async function GET() {
  const wsPath = getWorkspacePath();

  // Try reading state/servers.json first
  const servers = await readJsonFile<ServiceStatus[]>(path.join(wsPath, "state", "servers.json"));

  if (servers) {
    return apiResponse(servers);
  }

  // Fallback: build state from what we know
  const now = new Date().toISOString();
  const defaultServices: ServiceStatus[] = [
    {
      name: "OpenClaw Gateway",
      status: "up",
      port: 18789,
      lastCheck: now,
      details: "Local gateway on loopback",
    },
    {
      name: "Dashboard",
      status: "up",
      port: 3000,
      lastCheck: now,
      details: "Next.js dev server",
    },
    {
      name: "WhatsApp Channel",
      status: "up",
      lastCheck: now,
      details: "Connected via plugin",
    },
  ];

  // Try reading branch check data
  const branchCheck = await readJsonFile(path.join(wsPath, "state", "branch-check.json"));

  return apiResponse({
    services: defaultServices,
    branchCheck: branchCheck || null,
  });
}
