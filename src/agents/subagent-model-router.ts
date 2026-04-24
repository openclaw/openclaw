import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const execFileAsync = promisify(execFile);

export type SubagentModelRouterMode = "off" | "shadow" | "pilot" | "live";
export type SubagentModelRouterTaskType = "coding" | "research" | "vision" | "general";

export type SubagentModelRouterConfig = {
  mode?: SubagentModelRouterMode;
  telemetryPath?: string;
  command?: string;
  args?: string[];
  policyPath?: string;
};

export type SubagentModelRouterRecommendation = {
  enabled: boolean;
  mode: SubagentModelRouterMode;
  taskType: SubagentModelRouterTaskType;
  recommendedModel?: string;
  source: "heuristic" | "shared-model-router-cli";
  reason: string;
  routeEffectApplied: false;
};

export type SubagentModelRouterTelemetryEvent = {
  component: "openclaw.subagent_spawn";
  requestId: string;
  timestamp: string;
  mode: SubagentModelRouterMode;
  taskType: SubagentModelRouterTaskType;
  recommendedModel?: string;
  actualModel?: string;
  routeEffectApplied: false;
  status: "accepted" | "error";
  source: SubagentModelRouterRecommendation["source"];
  reason: string;
};

function readEnvString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readEnvMode(): SubagentModelRouterMode | undefined {
  const value = readEnvString("OPENCLAW_SUBAGENT_MODEL_ROUTER_MODE");
  return value === "off" || value === "shadow" || value === "pilot" || value === "live"
    ? value
    : undefined;
}

export function resolveSubagentModelRouterConfig(cfg: OpenClawConfig): SubagentModelRouterConfig {
  const configured = cfg.agents?.defaults?.subagents?.modelRouter ?? {};
  return {
    ...configured,
    mode: readEnvMode() ?? configured.mode ?? "off",
    telemetryPath:
      readEnvString("OPENCLAW_SUBAGENT_MODEL_ROUTER_TELEMETRY") ?? configured.telemetryPath,
    command: readEnvString("OPENCLAW_SUBAGENT_MODEL_ROUTER_COMMAND") ?? configured.command,
    policyPath: readEnvString("OPENCLAW_SUBAGENT_MODEL_ROUTER_POLICY") ?? configured.policyPath,
  };
}

export function classifySubagentModelRouterTask(task: string): SubagentModelRouterTaskType {
  if (/\b(code|coding|bug|debug|fix|test|repo|typescript|javascript|python)\b/i.test(task)) {
    return "coding";
  }
  if (/\b(research|analyze|analysis|compare|investigate)\b/i.test(task)) {
    return "research";
  }
  if (/\b(image|vision|screenshot|design|ui|ux)\b/i.test(task)) {
    return "vision";
  }
  return "general";
}

function fallbackModelForTaskType(taskType: SubagentModelRouterTaskType): string | undefined {
  if (taskType === "coding") return "openai-codex/gpt-5.5";
  if (taskType === "research") return "google/gemini-3-flash";
  return undefined;
}

async function routeWithSharedModelRouterCli(params: {
  config: SubagentModelRouterConfig;
  taskType: SubagentModelRouterTaskType;
}): Promise<string | undefined> {
  const command = params.config.command;
  if (!command) return undefined;
  const args = [
    ...(params.config.args ?? []),
    ...(params.config.policyPath ? ["--config", params.config.policyPath] : []),
    "--task-type",
    params.taskType,
    "--mode",
    "execute",
    "--priority",
    "normal",
    "--primary-only",
  ];
  const { stdout } = await execFileAsync(command, args, { timeout: 5_000 });
  const model = stdout.trim().split(/\r?\n/).at(-1)?.trim();
  return model || undefined;
}

export async function resolveSubagentModelRouterRecommendation(params: {
  cfg: OpenClawConfig;
  task: string;
  modelOverride?: string;
}): Promise<SubagentModelRouterRecommendation | undefined> {
  const config = resolveSubagentModelRouterConfig(params.cfg);
  const mode = config.mode ?? "off";
  if (mode === "off") return undefined;
  const taskType = classifySubagentModelRouterTask(params.task);

  let source: SubagentModelRouterRecommendation["source"] = "heuristic";
  let reason = "shadow-only recommendation; no live override applied";
  let recommendedModel: string | undefined;
  if (!params.modelOverride) {
    try {
      recommendedModel = await routeWithSharedModelRouterCli({ config, taskType });
      if (recommendedModel) {
        source = "shared-model-router-cli";
        reason = "shared model-router CLI recommendation; no live override applied";
      }
    } catch (err) {
      reason = `shared model-router CLI failed; using heuristic fallback; no live override applied: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
    recommendedModel ??= fallbackModelForTaskType(taskType);
  } else {
    reason = "explicit model override present; router kept recommendation shadow-only";
  }

  return {
    enabled: true,
    mode,
    taskType,
    recommendedModel,
    source,
    reason,
    routeEffectApplied: false,
  };
}

export async function appendSubagentModelRouterTelemetry(params: {
  config: SubagentModelRouterConfig;
  event: SubagentModelRouterTelemetryEvent;
}): Promise<void> {
  const telemetryPath = params.config.telemetryPath;
  if (!telemetryPath) return;
  await fs.mkdir(telemetryPath.replace(/[/\\][^/\\]*$/, "") || ".", { recursive: true });
  await fs.appendFile(telemetryPath, `${JSON.stringify(params.event)}\n`, "utf8");
}
