/**
 * dmad-agent-health.mts — quick CLI health check for DMAD agents.
 *
 * This probes CLI spawn/version output with execFile-compatible semantics.
 * It does not call model APIs.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type AgentName = "claude" | "codex";

type AgentHealthCode =
  | "ok"
  | "cli_missing"
  | "spawn_eperm"
  | "timeout"
  | "exec_failed"
  | "no_version_output";

interface AgentHealth {
  agent: AgentName;
  ok: boolean;
  code: AgentHealthCode;
  command: string;
  version: string | null;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  message: string;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDir, "..");
const REPORT_PATH = path.join(REPO_ROOT, "reports/dmad-agent-health-latest.json");
const CHECK_TIMEOUT_MS = 5_000;
const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>%\r\n]/;

function firstLine(text: string): string | null {
  const line = text.trim().split(/\r?\n/).find(Boolean);
  return line ? line.slice(0, 300) : null;
}

function classifyFailure(output: string, errorCode?: string): AgentHealthCode {
  if (errorCode === "ETIMEDOUT") {
    return "timeout";
  }
  if (errorCode === "EPERM" || /EPERM|Access is denied|拒絕存取/i.test(output)) {
    return "spawn_eperm";
  }
  if (
    errorCode === "ENOENT" ||
    /not recognized|not found|找不到|不是內部或外部命令/i.test(output)
  ) {
    return "cli_missing";
  }
  return output.trim() ? "exec_failed" : "no_version_output";
}

function escapeWindowsCmdArg(arg: string): string {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(`Unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}`);
  }
  const escaped = arg.replace(/\^/g, "^^");
  if (!escaped.includes(" ") && !escaped.includes('"')) {
    return escaped;
  }
  return `"${escaped.replace(/"/g, '""')}"`;
}

function buildWindowsCmdLine(command: string, args: readonly string[]): string {
  return [escapeWindowsCmdArg(command), ...args.map(escapeWindowsCmdArg)].join(" ");
}

function buildVersionProbe(agent: AgentName): { command: string; args: string[]; display: string } {
  const versionArgs = ["--version"];
  if (process.platform !== "win32") {
    return {
      command: agent,
      args: versionArgs,
      display: `${agent} --version`,
    };
  }
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", buildWindowsCmdLine(agent, versionArgs)],
    display: `${agent} --version`,
  };
}

function checkAgent(agent: AgentName): AgentHealth {
  const startedAt = Date.now();
  const probe = buildVersionProbe(agent);
  const result = spawnSync(probe.command, probe.args, {
    encoding: "utf8",
    env: { ...process.env },
    timeout: CHECK_TIMEOUT_MS,
    windowsVerbatimArguments: process.platform === "win32",
    windowsHide: true,
  });
  const durationMs = Date.now() - startedAt;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const version = firstLine(output);
  const errorCode = typeof result.error?.code === "string" ? result.error.code : undefined;

  if (result.status === 0 && version) {
    return {
      agent,
      ok: true,
      code: "ok",
      command: probe.display,
      version,
      exitCode: result.status,
      signal: result.signal,
      durationMs,
      message: `${agent} CLI 可用於 DMAD execFile 路徑`,
    };
  }

  const code = classifyFailure(output, errorCode);
  return {
    agent,
    ok: false,
    code,
    command: probe.display,
    version,
    exitCode: result.status,
    signal: result.signal,
    durationMs,
    message: version ?? result.error?.message?.slice(0, 300) ?? `${agent} CLI 無版本輸出`,
  };
}

function degradedReason(agents: AgentHealth[]): string | null {
  const counters = {
    claude_missing: 0,
    claude_failed: 0,
    codex_missing: 0,
    codex_failed: 0,
  };

  for (const agent of agents) {
    if (agent.ok) {
      continue;
    }
    if (agent.agent === "claude") {
      if (agent.code === "cli_missing") {
        counters.claude_missing++;
      } else {
        counters.claude_failed++;
      }
    } else {
      if (agent.code === "cli_missing") {
        counters.codex_missing++;
      } else {
        counters.codex_failed++;
      }
    }
  }

  const parts = Object.entries(counters)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key}=${count}`);
  return parts.length > 0 ? parts.join(",") : null;
}

const agents = [checkAgent("claude"), checkAgent("codex")];
const qualityStatus = agents.every((agent) => agent.ok) ? "pass" : "degraded_agents";
const report = {
  generatedAt: new Date().toISOString(),
  qualityStatus,
  degradedReason: degradedReason(agents),
  timeoutMs: CHECK_TIMEOUT_MS,
  agents,
};

fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = qualityStatus === "pass" ? 0 : 1;
