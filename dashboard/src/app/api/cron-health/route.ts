import path from "path";
import { getOpenClawPath, readJsonFile, apiResponse } from "@/lib/workspace";

interface CronConfig {
  version: number;
  jobs: Array<{
    name?: string;
    schedule?: string;
    command?: string;
    enabled?: boolean;
    lastRun?: string;
    lastStatus?: string;
    consecutiveErrors?: number;
  }>;
}

export async function GET() {
  const ocPath = getOpenClawPath();
  const cronData = await readJsonFile<CronConfig>(path.join(ocPath, "cron", "jobs.json"));

  // Also check for agent heartbeat schedules as implicit cron jobs
  const config = await readJsonFile<{
    agents?: {
      list?: Array<{
        id: string;
        name: string;
        heartbeat?: { every: string; session: string };
        identity?: { name: string; emoji: string };
      }>;
    };
  }>(path.join(ocPath, "openclaw.json"));

  const heartbeatJobs = (config?.agents?.list || [])
    .filter((a) => a.heartbeat)
    .map((a) => ({
      name: `${a.identity?.emoji || ""} ${a.identity?.name || a.name} Heartbeat`.trim(),
      schedule: `Every ${a.heartbeat!.every}`,
      lastStatus: "success" as const,
      consecutiveErrors: 0,
      enabled: true,
      type: "heartbeat",
      agentId: a.id,
    }));

  return apiResponse({
    jobs: cronData?.jobs || [],
    heartbeats: heartbeatJobs,
  });
}
