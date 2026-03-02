import fs from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../../../../src/infra/tmp-openclaw-dir.js";
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

const MOCK_CLI_SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("node:fs");

const args = process.argv.slice(2);
const logPath = process.env.MOCK_ACPX_LOG;
const openclawShell = process.env.OPENCLAW_SHELL || "";
const writeLog = (entry) => {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
};
const emitJson = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");
const emitUpdate = (sessionId, update) =>
  emitJson({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update },
  });

if (args.includes("--version")) {
  process.stdout.write("mock-acpx ${ACPX_PINNED_VERSION}\\n");
  process.exit(0);
}

if (args.includes("--help")) {
  process.stdout.write("mock-acpx help\\n");
  process.exit(0);
}

const commandIndex = args.findIndex(
  (arg) =>
    arg === "prompt" ||
    arg === "cancel" ||
    arg === "sessions" ||
    arg === "set-mode" ||
    arg === "set" ||
    arg === "status",
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
  emitJson({
    action: "session_ensured",
    acpxRecordId: "rec-" + ensureName,
    acpxSessionId: "sid-" + ensureName,
    agentSessionId: "inner-" + ensureName,
    name: ensureName,
    created: true,
  });
  process.exit(0);
}

if (command === "cancel") {
  writeLog({ kind: "cancel", agent, args, sessionName: sessionFromOption });
  emitJson({
    acpxSessionId: "sid-" + sessionFromOption,
    cancelled: true,
  });
  process.exit(0);
}

if (command === "set-mode") {
  writeLog({ kind: "set-mode", agent, args, sessionName: sessionFromOption, mode: setModeValue });
  emitJson({
    action: "mode_set",
    acpxSessionId: "sid-" + sessionFromOption,
    mode: setModeValue,
  });
  process.exit(0);
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
  process.exit(0);
}

if (command === "status") {
  writeLog({ kind: "status", agent, args, sessionName: sessionFromOption });
  emitJson({
    acpxRecordId: sessionFromOption ? "rec-" + sessionFromOption : null,
    acpxSessionId: sessionFromOption ? "sid-" + sessionFromOption : null,
    agentSessionId: sessionFromOption ? "inner-" + sessionFromOption : null,
    status: sessionFromOption ? "alive" : "no-session",
    pid: 4242,
    uptime: 120,
  });
  process.exit(0);
}

if (command === "sessions" && args[commandIndex + 1] === "close") {
  writeLog({ kind: "close", agent, args, sessionName: closeName });
  emitJson({
    action: "session_closed",
    acpxRecordId: "rec-" + closeName,
    acpxSessionId: "sid-" + closeName,
    name: closeName,
  });
  process.exit(0);
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
    emitJson({
      type: "error",
      code: "-32000",
      message: "mock failure",
    });
    process.exit(1);
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
    process.exit(0);
  }

  if (stdinText.includes("double-done")) {
    emitUpdate(sessionFromOption, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "ok" },
    });
    emitJson({ type: "done", stopReason: "end_turn" });
    emitJson({ type: "done", stopReason: "end_turn" });
    process.exit(0);
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
  process.exit(0);
}

writeLog({ kind: "unknown", args });
emitJson({
  type: "error",
  code: "USAGE",
  message: "unknown command",
});
process.exit(2);
`;

export async function createMockRuntimeFixture(params?: {
  permissionMode?: ResolvedAcpxPluginConfig["permissionMode"];
  queueOwnerTtlSeconds?: number;
}): Promise<{
  runtime: AcpxRuntime;
  logPath: string;
  config: ResolvedAcpxPluginConfig;
}> {
  const dir = await mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-acpx-runtime-test-"),
  );
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "mock-acpx.cjs");
  const logPath = path.join(dir, "calls.log");
  await writeFile(scriptPath, MOCK_CLI_SCRIPT, "utf8");
  await chmod(scriptPath, 0o755);
  process.env.MOCK_ACPX_LOG = logPath;

  const config: ResolvedAcpxPluginConfig = {
    command: scriptPath,
    allowPluginLocalInstall: false,
    installCommand: "n/a",
    cwd: dir,
    permissionMode: params?.permissionMode ?? "approve-all",
    nonInteractivePermissions: "fail",
    strictWindowsCmdWrapper: true,
    queueOwnerTtlSeconds: params?.queueOwnerTtlSeconds ?? 0.1,
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
