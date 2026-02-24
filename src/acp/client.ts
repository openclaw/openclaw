import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as readline from "node:readline";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { isKnownCoreToolId } from "../agents/tool-catalog.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { DANGEROUS_ACP_TOOLS } from "../security/dangerous-tools.js";

const SAFE_AUTO_APPROVE_TOOL_IDS = new Set(["read", "search", "web_search", "memory_search"]);
const TRUSTED_SAFE_TOOL_ALIASES = new Set(["search"]);
const READ_TOOL_PATH_KEYS = ["path", "file_path", "filePath"];
const TOOL_KIND_BY_ID = new Map<string, string>([
  ["read", "read"],
  ["search", "search"],
  ["web_search", "search"],
  ["memory_search", "search"],
]);

type PermissionOption = RequestPermissionRequest["options"][number];

type PermissionResolverDeps = {
  prompt?: (toolName: string | undefined, toolTitle?: string) => Promise<boolean>;
  log?: (line: string) => void;
  cwd?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readFirstStringValue(
  source: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!source) {
    return undefined;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeToolName(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return normalized;
}

function parseToolNameFromTitle(title: string | undefined | null): string | undefined {
  if (!title) {
    return undefined;
  }
  const head = title.split(":", 1)[0]?.trim();
  if (!head || !/^[a-zA-Z0-9._-]+$/.test(head)) {
    return undefined;
  }
  return normalizeToolName(head);
}

function resolveToolKindForPermission(toolName: string | undefined): string | undefined {
  if (!toolName) {
    return undefined;
  }
  return TOOL_KIND_BY_ID.get(toolName) ?? "other";
}

function resolveToolNameForPermission(params: RequestPermissionRequest): string | undefined {
  const toolCall = params.toolCall;
  const toolMeta = asRecord(toolCall?._meta);
  const rawInput = asRecord(toolCall?.rawInput);

  const fromMeta = readFirstStringValue(toolMeta, ["toolName", "tool_name", "name"]);
  const fromRawInput = readFirstStringValue(rawInput, ["tool", "toolName", "tool_name", "name"]);
  const fromTitle = parseToolNameFromTitle(toolCall?.title);
  return normalizeToolName(fromMeta ?? fromRawInput ?? fromTitle ?? "");
}

function extractPathFromToolTitle(
  toolTitle: string | undefined,
  toolName: string | undefined,
): string | undefined {
  if (!toolTitle) {
    return undefined;
  }
  const separator = toolTitle.indexOf(":");
  if (separator < 0) {
    return undefined;
  }
  const tail = toolTitle.slice(separator + 1).trim();
  if (!tail) {
    return undefined;
  }
  const keyedMatch = tail.match(/(?:^|,\s*)(?:path|file_path|filePath)\s*:\s*([^,]+)/);
  if (keyedMatch?.[1]) {
    return keyedMatch[1].trim();
  }
  if (toolName === "read") {
    return tail;
  }
  return undefined;
}

function resolveToolPathCandidate(
  params: RequestPermissionRequest,
  toolName: string | undefined,
  toolTitle: string | undefined,
): string | undefined {
  const rawInput = asRecord(params.toolCall?.rawInput);
  const fromRawInput = readFirstStringValue(rawInput, READ_TOOL_PATH_KEYS);
  const fromTitle = extractPathFromToolTitle(toolTitle, toolName);
  return fromRawInput ?? fromTitle;
}

function resolveAbsoluteScopedPath(value: string, cwd: string): string | undefined {
  let candidate = value.trim();
  if (!candidate) {
    return undefined;
  }
  if (candidate.startsWith("file://")) {
    try {
      const parsed = new URL(candidate);
      candidate = decodeURIComponent(parsed.pathname || "");
    } catch {
      return undefined;
    }
  }
  if (candidate === "~") {
    candidate = homedir();
  } else if (candidate.startsWith("~/")) {
    candidate = path.join(homedir(), candidate.slice(2));
  }
  const absolute = path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(cwd, candidate);
  return absolute;
}

function isPathWithinRoot(candidatePath: string, root: string): boolean {
  const relative = path.relative(root, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isReadToolCallScopedToCwd(
  params: RequestPermissionRequest,
  toolName: string | undefined,
  toolTitle: string | undefined,
  cwd: string,
): boolean {
  if (toolName !== "read") {
    return false;
  }
  const rawPath = resolveToolPathCandidate(params, toolName, toolTitle);
  if (!rawPath) {
    return false;
  }
  const absolutePath = resolveAbsoluteScopedPath(rawPath, cwd);
  if (!absolutePath) {
    return false;
  }
  return isPathWithinRoot(absolutePath, path.resolve(cwd));
}

function shouldAutoApproveToolCall(
  params: RequestPermissionRequest,
  toolName: string | undefined,
  toolTitle: string | undefined,
  cwd: string,
): boolean {
  const isTrustedToolId =
    typeof toolName === "string" &&
    (isKnownCoreToolId(toolName) || TRUSTED_SAFE_TOOL_ALIASES.has(toolName));
  if (!toolName || !isTrustedToolId || !SAFE_AUTO_APPROVE_TOOL_IDS.has(toolName)) {
    return false;
  }
  if (toolName === "read") {
    return isReadToolCallScopedToCwd(params, toolName, toolTitle, cwd);
  }
  return true;
}

function pickOption(
  options: PermissionOption[],
  kinds: PermissionOption["kind"][],
): PermissionOption | undefined {
  for (const kind of kinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function selectedPermission(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

function cancelledPermission(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

function promptUserPermission(toolName: string | undefined, toolTitle?: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    console.error(`[permission denied] ${toolName ?? "unknown"}: non-interactive terminal`);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    const finish = (approved: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      rl.close();
      resolve(approved);
    };

    const timeout = setTimeout(() => {
      console.error(`\n[permission timeout] denied: ${toolName ?? "unknown"}`);
      finish(false);
    }, 30_000);

    const label = toolTitle
      ? toolName
        ? `${toolTitle} (${toolName})`
        : toolTitle
      : (toolName ?? "unknown tool");
    rl.question(`\n[permission] Allow "${label}"? (y/N) `, (answer) => {
      const approved = answer.trim().toLowerCase() === "y";
      console.error(`[permission ${approved ? "approved" : "denied"}] ${toolName ?? "unknown"}`);
      finish(approved);
    });
  });
}

export async function resolvePermissionRequest(
  params: RequestPermissionRequest,
  deps: PermissionResolverDeps = {},
): Promise<RequestPermissionResponse> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const prompt = deps.prompt ?? promptUserPermission;
  const cwd = deps.cwd ?? process.cwd();
  const options = params.options ?? [];
  const toolTitle = params.toolCall?.title ?? "tool";
  const toolName = resolveToolNameForPermission(params);
  const toolKind = resolveToolKindForPermission(toolName);

  if (options.length === 0) {
    log(`[permission cancelled] ${toolName ?? "unknown"}: no options available`);
    return cancelledPermission();
  }

  const allowOption = pickOption(options, ["allow_once", "allow_always"]);
  const rejectOption = pickOption(options, ["reject_once", "reject_always"]);
  const autoApproveAllowed = shouldAutoApproveToolCall(params, toolName, toolTitle, cwd);
  const promptRequired = !toolName || !autoApproveAllowed || DANGEROUS_ACP_TOOLS.has(toolName);

  if (!promptRequired) {
    const option = allowOption ?? options[0];
    if (!option) {
      log(`[permission cancelled] ${toolName}: no selectable options`);
      return cancelledPermission();
    }
    log(`[permission auto-approved] ${toolName} (${toolKind ?? "unknown"})`);
    return selectedPermission(option.optionId);
  }

  log(
    `\n[permission requested] ${toolTitle}${toolName ? ` (${toolName})` : ""}${toolKind ? ` [${toolKind}]` : ""}`,
  );
  const approved = await prompt(toolName, toolTitle);

  if (approved && allowOption) {
    return selectedPermission(allowOption.optionId);
  }
  if (!approved && rejectOption) {
    return selectedPermission(rejectOption.optionId);
  }

  log(
    `[permission cancelled] ${toolName ?? "unknown"}: missing ${approved ? "allow" : "reject"} option`,
  );
  return cancelledPermission();
}

export type AcpClientOptions = {
  cwd?: string;
  serverCommand?: string;
  serverArgs?: string[];
  serverVerbose?: boolean;
  verbose?: boolean;
};

export type AcpClientHandle = {
  client: ClientSideConnection;
  agent: ChildProcess;
  sessionId: string;
};

function toArgs(value: string[] | string | undefined): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function buildServerArgs(opts: AcpClientOptions): string[] {
  const args = ["acp", ...toArgs(opts.serverArgs)];
  if (opts.serverVerbose && !args.includes("--verbose") && !args.includes("-v")) {
    args.push("--verbose");
  }
  return args;
}

function resolveSelfEntryPath(): string | null {
  // Prefer a path relative to the built module location (dist/acp/client.js -> dist/entry.js).
  try {
    const here = fileURLToPath(import.meta.url);
    const candidate = path.resolve(path.dirname(here), "..", "entry.js");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // ignore
  }

  const argv1 = process.argv[1]?.trim();
  if (argv1) {
    return path.isAbsolute(argv1) ? argv1 : path.resolve(process.cwd(), argv1);
  }
  return null;
}

function printSessionUpdate(notification: SessionNotification): void {
  const update = notification.update;
  if (!("sessionUpdate" in update)) {
    return;
  }

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      if (update.content?.type === "text") {
        process.stdout.write(update.content.text);
      }
      return;
    }
    case "tool_call": {
      console.log(`\n[tool] ${update.title} (${update.status})`);
      return;
    }
    case "tool_call_update": {
      if (update.status) {
        console.log(`[tool update] ${update.toolCallId}: ${update.status}`);
      }
      return;
    }
    case "available_commands_update": {
      const names = update.availableCommands?.map((cmd) => `/${cmd.name}`).join(" ");
      if (names) {
        console.log(`\n[commands] ${names}`);
      }
      return;
    }
    default:
      return;
  }
}

export async function createAcpClient(opts: AcpClientOptions = {}): Promise<AcpClientHandle> {
  const cwd = opts.cwd ?? process.cwd();
  const verbose = Boolean(opts.verbose);
  const log = verbose ? (msg: string) => console.error(`[acp-client] ${msg}`) : () => {};

  ensureOpenClawCliOnPath();
  const serverArgs = buildServerArgs(opts);

  const entryPath = resolveSelfEntryPath();
  const serverCommand = opts.serverCommand ?? (entryPath ? process.execPath : "openclaw");
  const effectiveArgs = opts.serverCommand || !entryPath ? serverArgs : [entryPath, ...serverArgs];

  log(`spawning: ${serverCommand} ${effectiveArgs.join(" ")}`);

  const agent = spawn(serverCommand, effectiveArgs, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
  });

  if (!agent.stdin || !agent.stdout) {
    throw new Error("Failed to create ACP stdio pipes");
  }

  const input = Writable.toWeb(agent.stdin);
  const output = Readable.toWeb(agent.stdout) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  const client = new ClientSideConnection(
    () => ({
      sessionUpdate: async (params: SessionNotification) => {
        printSessionUpdate(params);
      },
      requestPermission: async (params: RequestPermissionRequest) => {
        return resolvePermissionRequest(params, { cwd });
      },
    }),
    stream,
  );

  log("initializing");
  await client.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: "openclaw-acp-client", version: "1.0.0" },
  });

  log("creating session");
  const session = await client.newSession({
    cwd,
    mcpServers: [],
  });

  return {
    client,
    agent,
    sessionId: session.sessionId,
  };
}

export async function runAcpClientInteractive(opts: AcpClientOptions = {}): Promise<void> {
  const { client, agent, sessionId } = await createAcpClient(opts);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("OpenClaw ACP client");
  console.log(`Session: ${sessionId}`);
  console.log('Type a prompt, or "exit" to quit.\n');

  const prompt = () => {
    rl.question("> ", async (input) => {
      const text = input.trim();
      if (!text) {
        prompt();
        return;
      }
      if (text === "exit" || text === "quit") {
        agent.kill();
        rl.close();
        process.exit(0);
      }

      try {
        const response = await client.prompt({
          sessionId,
          prompt: [{ type: "text", text }],
        });
        console.log(`\n[${response.stopReason}]\n`);
      } catch (err) {
        console.error(`\n[error] ${String(err)}\n`);
      }

      prompt();
    });
  };

  prompt();

  agent.on("exit", (code) => {
    console.log(`\nAgent exited with code ${code ?? 0}`);
    rl.close();
    process.exit(code ?? 0);
  });
}
