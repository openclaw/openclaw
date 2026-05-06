import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import nodePath from "node:path";
import { promisify } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const execFileAsync = promisify(execFile);

export type SubagentModelRouterMode = "off" | "shadow" | "pilot" | "live";
export type SubagentModelRouterTaskType =
  | "chat"
  | "coding"
  | "writing"
  | "research"
  | "batch"
  | "trivial"
  | "visual"
  | "reasoning";

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
  resolvedConfig: SubagentModelRouterConfig;
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
  const text = task || "";
  if (
    /\b(code|coding|bug|debug|fix|test|repo|typescript|javascript|python)\b/i.test(text) ||
    /(באג|שגיאה|לוג|לוגים|נפל|נופל|לא עובד|תתקן|תקן|דיבאג|ריפו|בדיקות?)/i.test(text)
  ) {
    return "coding";
  }
  if (
    /\b(image|vision|screenshot|design|ui|ux)\b/i.test(text) ||
    /(תמונה|צילום מסך|עיצוב|ויזואל|ממשק)/i.test(text)
  ) {
    return "visual";
  }
  if (
    /\b(write|draft|copy|post|email|summarize|summary|report)\b/i.test(text) ||
    /(כתוב|טיוטה|פוסט|מייל|תסכם|סכם|דוח|סקירה)/i.test(text)
  ) {
    return "writing";
  }
  if (
    /\b(research|analyze|analysis|compare|investigate|search)\b/i.test(text) ||
    /(בדוק|חפש|מקורות|השווה|תחקור|נתח)/i.test(text)
  ) {
    return "research";
  }
  if (
    /\b(reason|plan|strategy|recommend|decide|should)\b/i.test(text) ||
    /(מה דעתך|כדאי|המלצות|אסטרטג|תכנון|לתכנן|להחליט)/i.test(text)
  ) {
    return "reasoning";
  }
  if (text.trim().length < 80) return "trivial";
  return "chat";
}

function fallbackModelForTaskType(taskType: SubagentModelRouterTaskType): string | undefined {
  if (taskType === "coding") return "openai-codex/gpt-5.3-codex";
  if (taskType === "visual") return "xai/grok-3-vision";
  if (taskType === "chat" || taskType === "writing" || taskType === "reasoning") {
    return "openai-codex/gpt-5.5";
  }
  if (taskType === "research" || taskType === "batch" || taskType === "trivial") {
    return "openai-codex/gpt-5.1-codex-mini";
  }
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
    "medium",
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
  if (mode === "pilot" || mode === "live") {
    // pilot/live not yet implemented — behaves as shadow and emits a warning
    console.warn(
      `[subagent-model-router] mode "${mode}" is not yet implemented; falling back to shadow-only behavior`,
    );
  }
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
    resolvedConfig: config,
  };
}

export async function appendSubagentModelRouterTelemetry(params: {
  config: SubagentModelRouterConfig;
  event: SubagentModelRouterTelemetryEvent;
}): Promise<void> {
  const telemetryPath = params.config.telemetryPath;
  if (!telemetryPath) return;
  await fs.mkdir(nodePath.dirname(telemetryPath) || ".", { recursive: true });
  await fs.appendFile(telemetryPath, `${JSON.stringify(params.event)}\n`, "utf8");
}
