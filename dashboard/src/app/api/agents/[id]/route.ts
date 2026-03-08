import path from "path";
import { getOpenClawPath, readJsonFile, readTextFile, listFiles, apiResponse, apiError } from "@/lib/workspace";
import { type NextRequest } from "next/server";

interface OpenClawConfig {
  agents?: {
    list?: Array<{
      id: string;
      name: string;
      model: string | { primary: string; fallbacks?: string[] };
      heartbeat?: Record<string, unknown>;
      identity?: { name: string; emoji: string };
      tools?: { allow?: string[] };
      subagents?: { allowAgents?: string[]; model?: string };
    }>;
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const ocPath = getOpenClawPath();

  const config = await readJsonFile<OpenClawConfig>(path.join(ocPath, "openclaw.json"));
  const agent = config?.agents?.list?.find((a) => a.id === id);

  if (!agent) {
    return apiError(`Agent '${id}' not found`, 404);
  }

  // Read agent-specific models
  const models = await readJsonFile(path.join(ocPath, "agents", id, "agent", "models.json"));

  // Try reading SOUL and RULES from workspace
  const workspacePath = path.join(ocPath, "workspace");
  const soul = await readTextFile(path.join(workspacePath, "SOUL.md")) ||
    await readTextFile(path.join(ocPath, `workspace-${id}`, "SOUL.md"));
  const rules = await readTextFile(path.join(workspacePath, "RULES.md")) ||
    await readTextFile(path.join(ocPath, `workspace-${id}`, "RULES.md"));

  // Count sessions
  const sessionsFile = await readJsonFile<Record<string, unknown>>(
    path.join(ocPath, "agents", id, "sessions", "sessions.json")
  );
  const sessionCount = sessionsFile ? Object.keys(sessionsFile).length : 0;

  // List recent outputs
  const outputDir = path.join(workspacePath, "shared-context", "agent-outputs");
  const outputs = await listFiles(outputDir, ".md");

  return apiResponse({
    ...agent,
    models,
    soul,
    rules,
    sessionCount,
    recentOutputs: outputs.slice(0, 10),
  });
}
