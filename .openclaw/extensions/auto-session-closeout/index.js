import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const execFileAsync = promisify(execFile);
const DEFAULT_AGENT_IDS = ["main"];
const DEFAULT_TRIGGERS = ["user"];
const DEFAULT_TIMEOUT_SECONDS = 20;
const DEFAULT_MIN_ITEMS = 2;
const processedRunIds = new Map();
const RUN_ID_TTL_MS = 10 * 60 * 1000;

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value, fallback = []) {
  if (!Array.isArray(value)) return [...fallback];
  return value.map((entry) => trimString(entry)).filter(Boolean);
}

function cleanupProcessedRunIds() {
  const cutoff = Date.now() - RUN_ID_TTL_MS;
  for (const [runId, seenAt] of processedRunIds.entries()) {
    if (seenAt < cutoff) processedRunIds.delete(runId);
  }
}

function shouldHandleAgent(cfg, agentId) {
  const allowed = normalizeStringList(cfg.agentIds, DEFAULT_AGENT_IDS);
  if (allowed.length === 0) return true;
  return allowed.includes(agentId);
}

function shouldHandleTrigger(cfg, trigger) {
  const allowed = normalizeStringList(cfg.triggers, DEFAULT_TRIGGERS);
  if (allowed.length === 0) return true;
  return allowed.includes(trigger);
}

function resolveHarnessPath(cfg, workspaceDir) {
  const configured = trimString(cfg.harnessPath);
  if (configured) return configured;
  if (!workspaceDir) return "";
  return path.join(workspaceDir, "scripts", "openclaw_harness.py");
}

function buildCloseoutCommand(params) {
  const command = [
    trimString(params.pythonBin) || "python3",
    params.harnessPath,
    "closeout-session",
    "--workspace",
    params.workspaceDir,
    "--agent-id",
    params.agentId,
    "--session-id",
    params.sessionId,
    "--latest-turn-only",
    "--min-items",
    String(params.minItems),
    "--run-id",
    params.runId,
    "--source",
    `auto-session-closeout:${params.agentId}:${params.sessionId}:${params.runId}`,
    "--format",
    "json"
  ];
  if (params.applyCloseout) command.push("--apply");
  if (params.applyMemory) command.push("--apply-memory");
  return command;
}

async function runCloseout(params, logger) {
  const timeoutMs = Math.max(1, params.timeoutSeconds) * 1000;
  const command = buildCloseoutCommand(params);
  try {
    const { stdout, stderr } = await execFileAsync(command[0], command.slice(1), {
      cwd: params.workspaceDir,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });
    if (stderr?.trim()) logger.debug?.(`auto-session-closeout stderr: ${stderr.trim()}`);
    const payload = JSON.parse(stdout || "{}");
    if (payload.persist_result?.applied) {
      logger.info?.(`auto-session-closeout persisted ${payload.persist_result.json}`);
      return;
    }
    const reason = payload.reason || payload.summary || "closeout_not_applied";
    logger.debug?.(`auto-session-closeout skipped: ${reason}`);
  } catch (error) {
    logger.warn?.(`auto-session-closeout failed: ${String(error)}`);
  }
}

export default definePluginEntry({
  id: "auto-session-closeout",
  name: "Auto Session Closeout",
  description: "Automatic session closeout and auto-memory persistence after successful user turns",
  register(api) {
    const pluginCfg = api.pluginConfig ?? {};
    api.on("agent_end", async (event, ctx) => {
      cleanupProcessedRunIds();
      if (!event?.success) return;

      const workspaceDir = trimString(ctx.workspaceDir);
      const agentId = trimString(ctx.agentId);
      const sessionId = trimString(ctx.sessionId);
      const trigger = trimString(ctx.trigger) || "user";
      const runId = trimString(ctx.runId);
      const harnessPath = resolveHarnessPath(pluginCfg, workspaceDir);

      if (!workspaceDir || !agentId || !sessionId || !runId || !harnessPath) return;
      if (!shouldHandleAgent(pluginCfg, agentId)) return;
      if (!shouldHandleTrigger(pluginCfg, trigger)) return;
      if (processedRunIds.has(runId)) return;

      processedRunIds.set(runId, Date.now());
      await runCloseout(
        {
          pythonBin: trimString(pluginCfg.pythonBin) || "python3",
          harnessPath,
          workspaceDir,
          agentId,
          sessionId,
          runId,
          minItems: Number.isInteger(pluginCfg.minItems) ? pluginCfg.minItems : DEFAULT_MIN_ITEMS,
          applyCloseout: pluginCfg.applyCloseout !== false,
          applyMemory: pluginCfg.applyMemory !== false,
          timeoutSeconds: Number.isInteger(pluginCfg.timeoutSeconds) ? pluginCfg.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS
        },
        api.logger
      );
    });
  }
});
