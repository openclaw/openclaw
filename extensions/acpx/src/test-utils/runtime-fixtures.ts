import fs from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import type { ResolvedAcpxPluginConfig } from "../config.js";
import { ACPX_PINNED_VERSION } from "../config.js";
import { AcpxRuntime } from "../runtime.js";

export const NOOP_LOGGER = {
  info: (_message: string) => {},
  warn: (_message: string) => {},
  error: (_message: string) => {},
  debug: (_message: string) => {},
};

const tempDirs: string[] = [];
let sharedMockCliScriptPath: Promise<string> | null = null;
let logFileSequence = 0;

const MOCK_CLI_SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("node:fs");

(async () => {
const args = process.argv.slice(2);
const logPath = process.env.MOCK_ACPX_LOG;
const openclawShell = process.env.OPENCLAW_SHELL || "";
const writeLog = (entry) => {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
};
const emitJson = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");
const flushAndExit = (code) => process.stdout.write("", () => process.exit(code));
const emitJsonAndExit = (payload, code = 0) => {
  emitJson(payload);
  flushAndExit(code);
};
const emitTextAndExit = (text, code = 0) => process.stdout.write(text, () => process.exit(code));
const emitUpdate = (sessionId, update) =>
  emitJson({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });

if (args.includes("--version")) {
  return emitTextAndExit("mock-acpx ${ACPX_PINNED_VERSION}\\n");
}

if (args.includes("--help")) {
  if (process.env.MOCK_ACPX_HELP_SIGNAL) {
    process.kill(process.pid, process.env.MOCK_ACPX_HELP_SIGNAL);
  }
  return emitTextAndExit("mock-acpx help\\n");
}

const commandIndex = args.findIndex(
  (arg) =>
    arg === "prompt" ||
    arg === "cancel" ||
    arg === "sessions" ||
    arg === "set-mode" ||
    arg === "set" ||
    arg === "status" ||
    arg === "config",
);
const command = commandIndex >= 0 ? args[commandIndex] : "";
const agent = commandIndex > 0 ? args[commandIndex - 1] : "unknown";

const readFlag = (flag) => {
  const idx = args.indexOf(flag);
  if (idx < 0) return "";
  return String(args[idx + 1] || "");
};

const sessionFromOption = readFlag("--session");
const ensureName = readFlag("--name");
const closeName =
  command === "sessions" && args[commandIndex + 1] === "close"
    ? String(args[commandIndex + 2] || "")
    : "";
const setModeValue = command === "set-mode" ? String(args[commandIndex + 1] || "") : "";
const setKey = command === "set" ? String(args[commandIndex + 1] || "") : "";
const setValue = command === "set" ? String(args[commandIndex + 2] || "") : "";

if (command === "sessions" && args[commandIndex + 1] === "ensure") {
  writeLog({ kind: "ensure", agent, args, sessionName: ensureName });
  if (process.env.MOCK_ACPX_ENSURE_EXIT_1 === "1") {
    return emitJsonAndExit({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32603,
        message: "mock ensure failure",
      },
    }, 1);
  }
  if (process.env.MOCK_ACPX_ENSURE_EMPTY === "1") {
    emitJson({ action: "session_ensured", name: ensureName });
  } else {
    emitJson({
      action: "session_ensured",
      acpxRecordId: "rec-" + ensureName,
      acpxSessionId: "sid-" + ensureName,
      agentSessionId: "inner-" + ensureName,
      name: ensureName,
      created: true,
    });
  }
  flushAndExit(0);
  return;
}

if (command === "sessions" && args[commandIndex + 1] === "new") {
  writeLog({ kind: "new", agent, args, sessionName: ensureName });
  if (process.env.MOCK_ACPX_NEW_EMPTY === "1") {
    emitJson({ action: "session_created", name: ensureName });
  } else {
    emitJson({
      action: "session_created",
      acpxRecordId: "rec-" + ensureName,
      acpxSessionId: "sid-" + ensureName,
      agentSessionId: "inner-" + ensureName,
      name: ensureName,
      created: true,
    });
  }
  flushAndExit(0);
  return;
}

if (command === "config" && args[commandIndex + 1] === "show") {
  const configuredAgents = process.env.MOCK_ACPX_CONFIG_SHOW_AGENTS
    ? JSON.parse(process.env.MOCK_ACPX_CONFIG_SHOW_AGENTS)
    : {};
  emitJson({
    defaultAgent: "codex",
    defaultPermissions: "approve-reads",
    nonInteractivePermissions: "deny",
    authPolicy: "skip",
    ttl: 300,
    timeout: null,
    format: "text",
    agents: configuredAgents,
    authMethods: [],
    paths: {
      global: "/tmp/mock-global.json",
      project: "/tmp/mock-project.json",
    },
    loaded: {
      global: false,
      project: false,
    },
  });
  flushAndExit(0);
  return;
}

if (command === "cancel") {
  writeLog({ kind: "cancel", agent, args, sessionName: sessionFromOption });
  return emitJsonAndExit({
    acpxSessionId: "sid-" + sessionFromOption,
    cancelled: true,
  });
}

if (command === "set-mode") {
  writeLog({ kind: "set-mode", agent, args, sessionName: sessionFromOption, mode: setModeValue });
  return emitJsonAndExit({
    action: "mode_set",
    acpxSessionId: "sid-" + sessionFromOption,
    mode: setModeValue,
  });
}

if (command === "set") {
  writeLog({
    kind: "set",
    agent,
    args,
    sessionName: sessionFromOption,
    key: setKey,
    value: setValue,
  });
  emitJson({
    action: "config_set",
    acpxSessionId: "sid-" + sessionFromOption,
    key: setKey,
    value: setValue,
  });
  flushAndExit(0);
  return;
}

if (command === "status") {
  writeLog({ kind: "status", agent, args, sessionName: sessionFromOption });
  if (process.env.MOCK_ACPX_STATUS_SIGNAL) {
    process.kill(process.pid, process.env.MOCK_ACPX_STATUS_SIGNAL);
  }
  const status = process.env.MOCK_ACPX_STATUS_STATUS || (sessionFromOption ? "alive" : "no-session");
  const summary = process.env.MOCK_ACPX_STATUS_SUMMARY || "";
  emitJson({
    acpxRecordId: sessionFromOption ? "rec-" + sessionFromOption : null,
    acpxSessionId: sessionFromOption ? "sid-" + sessionFromOption : null,
    agentSessionId: sessionFromOption ? "inner-" + sessionFromOption : null,
    status,
    ...(summary ? { summary } : {}),
    pid: 4242,
    uptime: 120,
  });
  flushAndExit(0);
  return;
}

if (command === "sessions" && args[commandIndex + 1] === "close") {
  writeLog({ kind: "close", agent, args, sessionName: closeName });
  return emitJsonAndExit({
    action: "session_closed",
    acpxRecordId: "rec-" + closeName,
    acpxSessionId: "sid-" + closeName,
    name: closeName,
  });
}

if (command === "prompt") {
  const stdinText = fs.readFileSync(0, "utf8");
  writeLog({
    kind: "prompt",
    agent,
    args,
    sessionName: sessionFromOption,
    stdinText,
    openclawShell,
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    githubToken: process.env.GITHUB_TOKEN || "",
  });
  const requestId = "req-1";

  emitJson({
    jsonrpc: "2.0",
    id: 0,
    method: "session/load",
    params: {
      sessionId: sessionFromOption,
      cwd: process.cwd(),
      mcpServers: [],
    },
  });
  emitJson({
    jsonrpc: "2.0",
    id: 0,
    error: {
      code: -32002,
      message: "Resource not found",
    },
  });

  emitJson({
    jsonrpc: "2.0",
    id: requestId,
    method: "session/prompt",
    params: {
      sessionId: sessionFromOption,
      prompt: [
        {
          type: "text",
          text: stdinText.trim(),
        },
      ],
    },
  });

  if (stdinText.includes("trigger-error")) {
    return emitJsonAndExit({
      type: "error",
      code: "-32000",
      message: "mock failure",
    }, 1);
  }

  if (stdinText.includes("permission-denied")) {
    flushAndExit(5);
    return;
  }

  if (process.env.MOCK_ACPX_PROMPT_SIGNAL) {
    process.kill(process.pid, process.env.MOCK_ACPX_PROMPT_SIGNAL);
  }

  if (stdinText.includes("split-spacing")) {
    emitUpdate(sessionFromOption, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "alpha" },
    });
    emitUpdate(sessionFromOption, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " beta" },
    });
    emitUpdate(sessionFromOption, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " gamma" },
    });
    emitJson({ type: "done", stopReason: "end_turn" });
    flushAndExit(0);
    return;
  }

  if (stdinText.includes("double-done")) {
    emitUpdate(sessionFromOption, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "ok" },
    });
    emitJson({ type: "done", stopReason: "end_turn" });
    emitJson({ type: "done", stopReason: "end_turn" });
    flushAndExit(0);
    return;
  }

  emitUpdate(sessionFromOption, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "thinking" },
  });
  emitUpdate(sessionFromOption, {
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "run-tests",
    status: "in_progress",
    kind: "command",
  });
  emitUpdate(sessionFromOption, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "echo:" + stdinText.trim() },
  });
  emitJson({ type: "done", stopReason: "end_turn" });
  flushAndExit(0);
  return;
}

writeLog({ kind: "unknown", args });
emitJsonAndExit({
  type: "error",
  code: "USAGE",
  message: "unknown command",
}, 2);
})().catch((error) => {
  process.stderr.write(String(error) + "\\n");
  process.exit(1);
});
`;

export async function createMockRuntimeFixture(params?: {
  permissionMode?: ResolvedAcpxPluginConfig["permissionMode"];
  queueOwnerTtlSeconds?: number;
  mcpServers?: ResolvedAcpxPluginConfig["mcpServers"];
}): Promise<{
  runtime: AcpxRuntime;
  logPath: string;
  config: ResolvedAcpxPluginConfig;
}> {
  const scriptPath = await ensureMockCliScriptPath();
  const dir = path.dirname(scriptPath);
  const logPath = path.join(dir, `calls-${logFileSequence++}.log`);
  process.env.MOCK_ACPX_LOG = logPath;

  const config: ResolvedAcpxPluginConfig = {
    command: scriptPath,
    allowPluginLocalInstall: false,
    stripProviderAuthEnvVars: false,
    installCommand: "n/a",
    cwd: dir,
    permissionMode: params?.permissionMode ?? "approve-all",
    nonInteractivePermissions: "fail",
    pluginToolsMcpBridge: false,
    strictWindowsCmdWrapper: true,
    queueOwnerTtlSeconds: params?.queueOwnerTtlSeconds ?? 0.1,
    mcpServers: params?.mcpServers ?? {},
  };

  return {
    runtime: new AcpxRuntime(config, {
      queueOwnerTtlSeconds: params?.queueOwnerTtlSeconds,
      logger: NOOP_LOGGER,
    }),
    logPath,
    config,
  };
}

async function ensureMockCliScriptPath(): Promise<string> {
  if (sharedMockCliScriptPath) {
    return await sharedMockCliScriptPath;
  }
  sharedMockCliScriptPath = (async () => {
    const dir = await mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-acpx-runtime-test-"),
    );
    tempDirs.push(dir);
    const scriptPath = path.join(dir, "mock-acpx.cjs");
    await writeFile(scriptPath, MOCK_CLI_SCRIPT, "utf8");
    await chmod(scriptPath, 0o755);
    return scriptPath;
  })();
  return await sharedMockCliScriptPath;
}

export async function readMockRuntimeLogEntries(
  logPath: string,
): Promise<Array<Record<string, unknown>>> {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const raw = await readFile(logPath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export async function cleanupMockRuntimeFixtures(): Promise<void> {
  delete process.env.MOCK_ACPX_LOG;
  delete process.env.MOCK_ACPX_CONFIG_SHOW_AGENTS;
  delete process.env.MOCK_ACPX_ENSURE_EXIT_1;
  delete process.env.MOCK_ACPX_STATUS_STATUS;
  delete process.env.MOCK_ACPX_STATUS_SUMMARY;
  sharedMockCliScriptPath = null;
  logFileSequence = 0;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 10,
    });
  }
}
