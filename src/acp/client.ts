import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { Readable, Writable } from "node:stream";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { DANGEROUS_ACP_TOOLS } from "../security/dangerous-tools.js";

const SAFE_AUTO_APPROVE_KINDS = new Set(["read", "search"]);

type PermissionOption = RequestPermissionRequest["options"][number];

type PermissionResolverDeps = {
  prompt?: (toolName: string | undefined, toolTitle?: string) => Promise<boolean>;
  log?: (line: string) => void;
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

function resolveToolKindForPermission(
  params: RequestPermissionRequest,
  toolName: string | undefined,
): string | undefined {
  const toolCall = params.toolCall as unknown as { kind?: unknown; title?: unknown } | undefined;
  const kindRaw = typeof toolCall?.kind === "string" ? toolCall.kind.trim().toLowerCase() : "";
  if (kindRaw) {
    return kindRaw;
  }
  const name =
    toolName ??
    parseToolNameFromTitle(typeof toolCall?.title === "string" ? toolCall.title : undefined);
  if (!name) {
    return undefined;
  }
  const normalized = name.toLowerCase();

  const hasToken = (token: string) => {
    // Tool names tend to be snake_case. Avoid substring heuristics (ex: "thread" contains "read").
    const re = new RegExp(`(?:^|[._-])${token}(?:$|[._-])`);
    return re.test(normalized);
  };

  // Prefer a conservative classifier: only classify safe kinds when confident.
  if (normalized === "read" || hasToken("read")) {
    return "read";
  }
  if (normalized === "search" || hasToken("search") || hasToken("find")) {
    return "search";
  }
  if (normalized.includes("fetch") || normalized.includes("http")) {
    return "fetch";
  }
  if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("patch")) {
    return "edit";
  }
  if (normalized.includes("delete") || normalized.includes("remove")) {
    return "delete";
  }
  if (normalized.includes("move") || normalized.includes("rename")) {
    return "move";
  }
  if (normalized.includes("exec") || normalized.includes("run") || normalized.includes("bash")) {
    return "execute";
  }
  return "other";
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
  const options = params.options ?? [];
  const toolTitle = params.toolCall?.title ?? "tool";
  const toolName = resolveToolNameForPermission(params);
  const toolKind = resolveToolKindForPermission(params, toolName);

  if (options.length === 0) {
    log(`[permission cancelled] ${toolName ?? "unknown"}: no options available`);
    return cancelledPermission();
  }

  const allowOption = pickOption(options, ["allow_once", "allow_always"]);
  const rejectOption = pickOption(options, ["reject_once", "reject_always"]);
  const isSafeKind = Boolean(toolKind && SAFE_AUTO_APPROVE_KINDS.has(toolKind));
  const promptRequired = !toolName || !isSafeKind || DANGEROUS_ACP_TOOLS.has(toolName);

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

  ensureOpenClawCliOnPath({ cwd });
  const serverCommand = opts.serverCommand ?? "openclaw";
  const serverArgs = buildServerArgs(opts);

  log(`spawning: ${serverCommand} ${serverArgs.join(" ")}`);

  const agent = spawn(serverCommand, serverArgs, {
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
        return resolvePermissionRequest(params);
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
