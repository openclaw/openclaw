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
const path = require("node:path");

(async () => {
const args = process.argv.slice(2);
const logPath = process.env.MOCK_ACPX_LOG;
const statePath =
  process.env.MOCK_ACPX_STATE ||
  path.join(path.dirname(logPath || process.cwd()), "mock-acpx-state.json");
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
const readState = () => {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        byName:
          parsed.byName && typeof parsed.byName === "object" && !Array.isArray(parsed.byName)
            ? parsed.byName
            : {},
        byAgentSessionId:
          parsed.byAgentSessionId &&
          typeof parsed.byAgentSessionId === "object" &&
          !Array.isArray(parsed.byAgentSessionId)
            ? parsed.byAgentSessionId
            : {},
      };
    }
  } catch {}
  return { byName: {}, byAgentSessionId: {} };
};
const writeState = (state) => {
  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
};
const defaultAgentSessionIdForName = (name) => {
  if (process.env.MOCK_ACPX_ENSURE_NO_AGENT_SESSION_ID === "1") {
    return "";
  }
  const prefix = process.env.MOCK_ACPX_AGENT_SESSION_PREFIX || "inner-";
  return prefix + name;
};
const cleanupAgentLookup = (state, name) => {
  for (const [sessionId, mappedName] of Object.entries(state.byAgentSessionId)) {
    if (mappedName === name) {
      delete state.byAgentSessionId[sessionId];
    }
  }
};
const storeSessionByName = (name, overrides = {}) => {
  const state = readState();
  const existing = state.byName[name] && typeof state.byName[name] === "object" ? state.byName[name] : {};
  const next = {
    acpxRecordId: "rec-" + name,
    acpxSessionId: "sid-" + name,
    agentSessionId: defaultAgentSessionIdForName(name),
    ...existing,
    ...overrides,
  };
  if (!next.acpxRecordId) {
    next.acpxRecordId = "rec-" + name;
  }
  if (!next.acpxSessionId) {
    next.acpxSessionId = "sid-" + name;
  }
  cleanupAgentLookup(state, name);
  state.byName[name] = next;
  if (next.agentSessionId) {
    state.byAgentSessionId[next.agentSessionId] = name;
  }
  writeState(state);
  return { name, ...next };
};
const findSessionByReference = (reference) => {
  if (!reference) {
    return null;
  }
  const state = readState();
  const byName = state.byName[reference];
  if (byName && typeof byName === "object") {
    return { name: reference, ...byName };
  }
  const mappedName = state.byAgentSessionId[reference];
  if (mappedName) {
    const mapped = state.byName[mappedName];
    if (mapped && typeof mapped === "object") {
      return { name: mappedName, ...mapped };
    }
  }
  for (const [name, session] of Object.entries(state.byName)) {
    if (!session || typeof session !== "object") {
      continue;
    }
    if (session.acpxSessionId === reference) {
      return { name, ...session };
    }
  }
  return null;
};
const resolveSession = (reference) => findSessionByReference(reference) || storeSessionByName(reference);

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
const resumeSessionId = readFlag("--resume-session");
const closeName =
  command === "sessions" && args[commandIndex + 1] === "close"
    ? String(args[commandIndex + 2] || "")
    : "";
const setModeValue = command === "set-mode" ? String(args[commandIndex + 1] || "") : "";
const setKey = command === "set" ? String(args[commandIndex + 1] || "") : "";
const setValue = command === "set" ? String(args[commandIndex + 2] || "") : "";

if (command === "sessions" && args[commandIndex + 1] === "ensure") {
  writeLog({ kind: "ensure", agent, args, sessionName: ensureName });
  if (process.env.MOCK_ACPX_ENSURE_STDERR) {
    process.stderr.write(String(process.env.MOCK_ACPX_ENSURE_STDERR) + "\n");
  }
  if (process.env.MOCK_ACPX_ENSURE_EXIT_1 === "1") {
    storeSessionByName(ensureName, resumeSessionId ? { agentSessionId: resumeSessionId } : {});
    return emitJsonAndExit({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32603,
        message: process.env.MOCK_ACPX_ENSURE_ERROR_MESSAGE || "mock ensure failure",
      },
    }, 1);
  }
  if (process.env.MOCK_ACPX_ENSURE_EMPTY === "1") {
    emitJson({ action: "session_ensured", name: ensureName });
  } else {
    const session = storeSessionByName(ensureName, resumeSessionId ? { agentSessionId: resumeSessionId } : {});
    emitJson({
      action: "session_ensured",
      acpxRecordId: session.acpxRecordId,
      acpxSessionId: session.acpxSessionId,
      ...(session.agentSessionId ? { agentSessionId: session.agentSessionId } : {}),
      name: ensureName,
      created: true,
    });
  }
  flushAndExit(0);
  return;
}

if (command === "sessions" && args[commandIndex + 1] === "new") {
  writeLog({ kind: "new", agent, args, sessionName: ensureName });
  if (process.env.MOCK_ACPX_NEW_FAIL_ON_RESUME === "1" && args.includes("--resume-session")) {
    return emitJsonAndExit(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32603,
          message: "mock stale resume session",
        },
      },
      1,
    );
  }
  if (process.env.MOCK_ACPX_NEW_EMPTY === "1") {
    emitJson({ action: "session_created", name: ensureName });
  } else {
    const session = storeSessionByName(ensureName, resumeSessionId ? { agentSessionId: resumeSessionId } : {});
    emitJson({
      action: "session_created",
      acpxRecordId: session.acpxRecordId,
      acpxSessionId: session.acpxSessionId,
      ...(session.agentSessionId ? { agentSessionId: session.agentSessionId } : {}),
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
  const session = findSessionByReference(sessionFromOption);
  writeLog({ kind: "cancel", agent, args, sessionName: sessionFromOption });
  return emitJsonAndExit({
    acpxSessionId: session ? session.acpxSessionId : "sid-" + sessionFromOption,
    cancelled: true,
  });
}

if (command === "set-mode") {
  const session = findSessionByReference(sessionFromOption);
  writeLog({ kind: "set-mode", agent, args, sessionName: sessionFromOption, mode: setModeValue });
  return emitJsonAndExit({
    action: "mode_set",
    acpxSessionId: session ? session.acpxSessionId : "sid-" + sessionFromOption,
    mode: setModeValue,
  });
}

if (command === "set") {
  const session = findSessionByReference(sessionFromOption);
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
    acpxSessionId: session ? session.acpxSessionId : "sid-" + sessionFromOption,
    key: setKey,
    value: setValue,
  });
  flushAndExit(0);
  return;
}

if (command === "status") {
  const session = findSessionByReference(sessionFromOption);
  writeLog({ kind: "status", agent, args, sessionName: sessionFromOption });
  if (process.env.MOCK_ACPX_STATUS_SIGNAL) {
    process.kill(process.pid, process.env.MOCK_ACPX_STATUS_SIGNAL);
  }
  const status = process.env.MOCK_ACPX_STATUS_STATUS || (sessionFromOption ? "alive" : "no-session");
  const summary = process.env.MOCK_ACPX_STATUS_SUMMARY || "";
  const omitStatusIds = process.env.MOCK_ACPX_STATUS_NO_IDS === "1";
  emitJson({
    acpxRecordId: !omitStatusIds && session ? session.acpxRecordId : null,
    acpxSessionId: !omitStatusIds && session ? session.acpxSessionId : null,
    agentSessionId: !omitStatusIds && session ? session.agentSessionId || null : null,
    status,
    ...(summary ? { summary } : {}),
    pid: 4242,
    uptime: 120,
  });
  flushAndExit(0);
  return;
}

if (command === "sessions" && args[commandIndex + 1] === "close") {
  const session = findSessionByReference(closeName) || storeSessionByName(closeName);
  writeLog({ kind: "close", agent, args, sessionName: closeName });
  return emitJsonAndExit({
    action: "session_closed",
    acpxRecordId: session.acpxRecordId,
    acpxSessionId: session.acpxSessionId,
    name: closeName,
  });
}

if (command === "prompt") {
  const stdinText = fs.readFileSync(0, "utf8");
  const session = resolveSession(sessionFromOption);
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
  let activeSessionId = session.agentSessionId || sessionFromOption;

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

  const shouldRejectLoad =
    process.env.MOCK_ACPX_PROMPT_LOAD_INVALID === "1" &&
    (!session.agentSessionId || sessionFromOption !== session.agentSessionId);
  if (shouldRejectLoad) {
    const nextAgentSessionId =
      process.env.MOCK_ACPX_PROMPT_NEW_AGENT_SESSION_ID || "agent-fallback-" + session.name;
    const refreshed = storeSessionByName(session.name, {
      agentSessionId: nextAgentSessionId,
    });
    emitJson({
      jsonrpc: "2.0",
      id: 0,
      error: {
        code: -32002,
        message: "Invalid session identifier",
      },
    });
    emitJson({
      jsonrpc: "2.0",
      id: 0,
      result: {
        sessionId: nextAgentSessionId,
      },
    });
    activeSessionId = refreshed.agentSessionId || nextAgentSessionId;
  } else {
    if (process.env.MOCK_ACPX_PROMPT_OMIT_LOAD_RESULT !== "1") {
      emitJson({
        jsonrpc: "2.0",
        id: 0,
        result: {
          sessionId: activeSessionId,
        },
      });
    }
  }

  emitJson({
    jsonrpc: "2.0",
    id: requestId,
    method: "session/prompt",
    params: {
      sessionId: activeSessionId,
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
    emitUpdate(activeSessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "alpha" },
    });
    emitUpdate(activeSessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " beta" },
    });
    emitUpdate(activeSessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " gamma" },
    });
    emitJson({ type: "done", stopReason: "end_turn" });
    flushAndExit(0);
    return;
  }

  if (stdinText.includes("double-done")) {
    emitUpdate(activeSessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "ok" },
    });
    emitJson({ type: "done", stopReason: "end_turn" });
    emitJson({ type: "done", stopReason: "end_turn" });
    flushAndExit(0);
    return;
  }

  emitUpdate(activeSessionId, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "thinking" },
  });
  emitUpdate(activeSessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "run-tests",
    status: "in_progress",
    kind: "command",
  });
  emitUpdate(activeSessionId, {
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
  const statePath = path.join(dir, `state-${logFileSequence - 1}.json`);
  process.env.MOCK_ACPX_LOG = logPath;
  process.env.MOCK_ACPX_STATE = statePath;

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
  delete process.env.MOCK_ACPX_STATE;
  delete process.env.MOCK_ACPX_CONFIG_SHOW_AGENTS;
  delete process.env.MOCK_ACPX_ENSURE_ERROR_MESSAGE;
  delete process.env.MOCK_ACPX_ENSURE_EXIT_1;
  delete process.env.MOCK_ACPX_ENSURE_STDERR;
  delete process.env.MOCK_ACPX_NEW_FAIL_ON_RESUME;
  delete process.env.MOCK_ACPX_ENSURE_EMPTY;
  delete process.env.MOCK_ACPX_ENSURE_NO_AGENT_SESSION_ID;
  delete process.env.MOCK_ACPX_NEW_EMPTY;
  delete process.env.MOCK_ACPX_AGENT_SESSION_PREFIX;
  delete process.env.MOCK_ACPX_PROMPT_LOAD_INVALID;
  delete process.env.MOCK_ACPX_PROMPT_NEW_AGENT_SESSION_ID;
  delete process.env.MOCK_ACPX_STATUS_STATUS;
  delete process.env.MOCK_ACPX_STATUS_NO_IDS;
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
