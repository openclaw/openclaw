import path from "path";
import { getOpenClawPath, readJsonFile, apiResponse, apiError } from "@/lib/workspace";

interface OpenClawConfig {
  agents?: {
    list?: Array<{
      id: string;
      name: string;
      default?: boolean;
      model: string | { primary: string; fallbacks?: string[] };
      heartbeat?: { every: string; session: string; target?: string; prompt?: string };
      identity?: { name: string; emoji: string };
      tools?: { allow?: string[] };
      groupChat?: { mentionPatterns: string[]; historyLimit: number };
      subagents?: { allowAgents?: string[]; model?: string };
    }>;
  };
}

const agentRoles: Record<string, { role: string; level: string }> = {
  jaum: { role: "Squad Lead / Coordinator", level: "L4" },
  atlas: { role: "Backend Developer", level: "L3" },
  pixel: { role: "Frontend Developer", level: "L3" },
  sentinel: { role: "QA / Tester", level: "L2" },
  forge: { role: "DevOps / Infra", level: "L2" },
  sage: { role: "Tech Writer / Docs", level: "L2" },
  hawk: { role: "Code Reviewer", level: "L3" },
  profiler: { role: "Resume & Profile Analyst", level: "L3" },
  scout: { role: "Job Hunter", level: "L3" },
  matcher: { role: "Job Fit Analyst", level: "L3" },
  apply: { role: "Application Specialist", level: "L3" },
  main: { role: "Default Agent", level: "L1" },
  jarvis: { role: "General Assistant", level: "L2" },
};

export async function GET() {
  const ocPath = getOpenClawPath();
  const config = await readJsonFile<OpenClawConfig>(path.join(ocPath, "openclaw.json"));

  if (!config?.agents?.list) {
    return apiError("Could not read agent configuration", 404);
  }

  const agents = config.agents.list.map((a) => {
    const modelStr = typeof a.model === "string" ? a.model : a.model?.primary || "unknown";
    const info = agentRoles[a.id] || { role: "Agent", level: "L1" };

    return {
      id: a.id,
      name: a.identity?.name || a.name || a.id,
      emoji: a.identity?.emoji || "",
      role: info.role,
      level: info.level,
      model: modelStr.split("/").pop() || modelStr,
      modelFull: modelStr,
      status: "active" as const,
      tools: a.tools?.allow || [],
      heartbeat: a.heartbeat ? {
        every: a.heartbeat.every,
        target: a.heartbeat.target,
      } : null,
      canSpawnSubagents: !!a.subagents?.allowAgents?.length,
    };
  });

  return apiResponse(agents);
}
