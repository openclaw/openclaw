import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { runCommandBuffered, withCommandProcessScope } from "openclaw/plugin-sdk/process-runtime";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import { resolveCodexAppServerUserHomeDir } from "./app-server/auth-start-options.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import { visitJsonlLines } from "./jsonl-lines.js";
import { codexCatalogHomeId } from "./session-catalog-home-id.js";
import { MAX_SESSION_ID_LENGTH, readBoundedOptionalString } from "./session-catalog-parsing.js";
import type { CodexSessionCatalogControlFactory } from "./session-catalog-types.js";

const CODEX_CLI_SESSIONS_LIST_COMMAND = "codex.cli.sessions.list";
export const CODEX_CLI_SESSION_RESUME_COMMAND = "codex.cli.session.resume";
export const CODEX_CLI_SESSION_SOURCE_CAPABILITY = "codex-cli-session-source";
export const CODEX_CLI_SESSION_SOURCE_UPGRADE_MESSAGE =
  "Update the node and approve its refreshed capabilities before continuing this Codex catalog session.";

const DEFAULT_SESSION_LIMIT = 10;
const MAX_SESSION_LIMIT = 50;
const DEFAULT_RESUME_TIMEOUT_MS = 20 * 60_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const activeResumeSessions = new Set<string>();

type CodexCliSessionSummary = {
  sessionId: string;
  updatedAt?: string;
  lastMessage?: string;
  cwd?: string;
  sessionFile?: string;
  messageCount: number;
};

type CodexCliSessionsListResult = {
  sessions: CodexCliSessionSummary[];
  codexHome: string;
};

type CodexCliSessionResumeResult = {
  ok: true;
  sessionId: string;
  text: string;
};

type CodexCliSessionNodeInfo = {
  nodeId?: string;
  displayName?: string;
  remoteIp?: string;
  connected?: boolean;
  commands?: string[];
};

type ResolveCatalogSource = (
  agentId: string,
) => Promise<
  Pick<
    Awaited<ReturnType<CodexSessionCatalogControlFactory["forNode"]>>,
    "codexHome" | "sourceHomeId" | "transport" | "assertCurrent"
  >
>;

export function createCodexCliSessionNodeHostCommands(
  resolveCatalogSource: ResolveCatalogSource,
): OpenClawPluginNodeHostCommand[] {
  return [
    {
      command: CODEX_CLI_SESSIONS_LIST_COMMAND,
      cap: "codex-cli-sessions",
      hasActiveWork: () => false,
      handle: listLocalCodexCliSessions,
    },
    {
      command: CODEX_CLI_SESSION_RESUME_COMMAND,
      cap: CODEX_CLI_SESSION_SOURCE_CAPABILITY,
      dangerous: true,
      hasActiveWork: () => activeResumeSessions.size > 0,
      handle: (paramsJSON, _io, context) =>
        resumeLocalCodexCliSession(paramsJSON, resolveCatalogSource, context),
    },
  ];
}

export function createCodexCliSessionNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [CODEX_CLI_SESSIONS_LIST_COMMAND],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (ctx) => ctx.invokeNode(),
    },
    {
      commands: [CODEX_CLI_SESSION_RESUME_COMMAND],
      dangerous: true,
      handle: (ctx) =>
        isRecord(ctx.params) &&
        (ctx.params.agentId !== undefined || ctx.params.sourceHomeId !== undefined) &&
        !ctx.node?.caps?.includes(CODEX_CLI_SESSION_SOURCE_CAPABILITY)
          ? {
              ok: false,
              code: "CODEX_NODE_SOURCE_UNAVAILABLE",
              message: CODEX_CLI_SESSION_SOURCE_UPGRADE_MESSAGE,
            }
          : ctx.invokeNode(),
    },
  ];
}

export async function listCodexCliSessionsOnNode(params: {
  runtime: PluginRuntime;
  requestedNode?: string;
  filter?: string;
  limit?: number;
}): Promise<{ node: CodexCliSessionNodeInfo; result: CodexCliSessionsListResult }> {
  const node = await resolveCodexCliNode({
    runtime: params.runtime,
    requestedNode: params.requestedNode,
    command: CODEX_CLI_SESSIONS_LIST_COMMAND,
  });
  const raw = await params.runtime.nodes.invoke({
    nodeId: readNodeId(node),
    command: CODEX_CLI_SESSIONS_LIST_COMMAND,
    params: {
      limit: params.limit,
      filter: params.filter,
    },
    timeoutMs: 15_000,
    scopes: ["operator.write"],
  });
  return { node, result: parseCodexCliSessionsListResult(raw) };
}

export async function resolveCodexCliSessionForBindingOnNode(params: {
  runtime: PluginRuntime;
  requestedNode: string;
  sessionId: string;
}): Promise<{ node: CodexCliSessionNodeInfo; session?: CodexCliSessionSummary }> {
  const listing = await listCodexCliSessionsOnNode({
    runtime: params.runtime,
    requestedNode: params.requestedNode,
    filter: params.sessionId,
    limit: MAX_SESSION_LIMIT,
  });
  if (!listing.node.commands?.includes(CODEX_CLI_SESSION_RESUME_COMMAND)) {
    throw new Error(
      `Node ${formatNodeLabel(listing.node)} does not expose ${CODEX_CLI_SESSION_RESUME_COMMAND}.`,
    );
  }
  return {
    node: listing.node,
    session: listing.result.sessions.find((session) => session.sessionId === params.sessionId),
  };
}

export async function resumeCodexCliSessionOnNode(params: {
  runtime: PluginRuntime;
  nodeId: string;
  sessionId: string;
  agentId?: string;
  sessionKey?: string;
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<CodexCliSessionResumeResult> {
  let catalogAgentId: string | undefined;
  let catalogHomeId: string | undefined;
  if (params.sessionKey) {
    const { adoptionSessionKeyRest, CODEX_NODE_SESSION_KEY_PREFIX, readNodeSessionMarker } =
      await import("./session-catalog-node-adoption.js");
    const entry = params.runtime.agent.session.getSessionEntry({
      sessionKey: params.sessionKey,
      readConsistency: "latest",
    });
    const codex = entry?.pluginExtensions?.codex;
    if (
      adoptionSessionKeyRest(params.sessionKey).startsWith(CODEX_NODE_SESSION_KEY_PREFIX) ||
      (isRecord(codex) && codex.sessionCatalog !== undefined)
    ) {
      const marker = entry ? readNodeSessionMarker(entry) : undefined;
      catalogAgentId = params.agentId?.trim();
      if (
        !catalogAgentId ||
        parseAgentSessionKey(params.sessionKey)?.agentId !== catalogAgentId ||
        !marker ||
        marker.initializing === true ||
        marker.nodeId !== params.nodeId ||
        marker.sourceHostId !== `node:${params.nodeId}` ||
        marker.sourceThreadId !== params.sessionId ||
        entry?.initializationPending === true ||
        entry?.agentHarnessId !== "codex" ||
        entry.modelSelectionLocked !== true
      ) {
        throw new Error("Codex catalog session changed before its node turn could run.");
      }
      if (!marker.sourceHomeId) {
        throw new Error(
          "This Codex catalog session has no saved source home. Reopen it from the catalog to continue in a new chat.",
        );
      }
      catalogHomeId = marker.sourceHomeId;
    }
  }
  const raw = await params.runtime.nodes.invoke({
    nodeId: params.nodeId,
    command: CODEX_CLI_SESSION_RESUME_COMMAND,
    params: {
      sessionId: params.sessionId,
      ...(catalogAgentId ? { agentId: catalogAgentId } : {}),
      ...(catalogHomeId ? { sourceHomeId: catalogHomeId } : {}),
      prompt: params.prompt,
      cwd: params.cwd,
      timeoutMs: params.timeoutMs,
    },
    timeoutMs: (params.timeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS) + 5_000,
    scopes: ["operator.write"],
  });
  const payload = unwrapNodeInvokePayload(raw);
  if (!isRecord(payload) || payload.ok !== true || typeof payload.text !== "string") {
    throw new Error("Codex CLI resume returned an invalid payload.");
  }
  return {
    ok: true,
    sessionId: typeof payload.sessionId === "string" ? payload.sessionId : params.sessionId,
    text: payload.text,
  };
}

export function formatCodexCliSessions(params: {
  node: CodexCliSessionNodeInfo;
  result: CodexCliSessionsListResult;
}): string {
  if (params.result.sessions.length === 0) {
    return `No Codex CLI sessions returned from ${formatCodexDisplayText(formatNodeLabel(params.node))}.`;
  }
  return [
    `Codex CLI sessions on ${formatCodexDisplayText(formatNodeLabel(params.node))}:`,
    ...params.result.sessions.map((session) => {
      const details = [session.cwd, session.updatedAt].filter((value): value is string =>
        Boolean(value),
      );
      return `- ${formatCodexDisplayText(session.sessionId)}${
        session.lastMessage ? ` - ${formatCodexDisplayText(session.lastMessage)}` : ""
      }${details.length > 0 ? ` (${details.map(formatCodexDisplayText).join(", ")})` : ""}\n  Bind: /codex resume ${formatCodexDisplayText(
        session.sessionId,
      )} --host ${formatCodexDisplayText(readNodeId(params.node))} --bind here`;
    }),
  ].join("\n");
}

async function listLocalCodexCliSessions(paramsJSON?: string | null): Promise<string> {
  const params = parseJsonRecord(paramsJSON);
  const limit = normalizeLimit(params.limit);
  const filter = typeof params.filter === "string" ? params.filter.trim().toLowerCase() : "";
  const codexHome = resolveCodexAppServerUserHomeDir();
  const summaries = await readHistorySessions(codexHome);
  await hydrateSessionsFromSessionFiles(codexHome, summaries);
  const sessions = [...summaries.values()]
    .filter((session) => {
      if (!filter) {
        return true;
      }
      return [session.sessionId, session.cwd, session.lastMessage].some((value) =>
        value?.toLowerCase().includes(filter),
      );
    })
    .toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, limit);
  return JSON.stringify({ sessions, codexHome } satisfies CodexCliSessionsListResult);
}

async function resumeLocalCodexCliSession(
  paramsJSON: string | null | undefined,
  resolveCatalogSource: ResolveCatalogSource,
  context?: Parameters<OpenClawPluginNodeHostCommand["handle"]>[2],
): Promise<string> {
  context?.signal?.throwIfAborted();
  const params = parseJsonRecord(paramsJSON);
  const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  const expectedHomeId = readBoundedOptionalString(params, "sourceHomeId", MAX_SESSION_ID_LENGTH);
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("Missing or invalid Codex CLI session id.");
  }
  if (!prompt) {
    throw new Error("Missing Codex CLI prompt.");
  }
  let codexHome = resolveCodexAppServerUserHomeDir();
  let sourceHomeId: string;
  let assertCurrent: (() => void) | undefined;
  if (params.agentId !== undefined) {
    if (typeof params.agentId !== "string" || !params.agentId.trim()) {
      throw new Error("Codex catalog agent id must be a nonempty string.");
    }
    const source = await resolveCatalogSource(params.agentId.trim());
    if (source.transport !== "stdio") {
      throw new Error("Codex CLI continuation requires a local Codex catalog source.");
    }
    codexHome = source.codexHome;
    sourceHomeId = source.sourceHomeId;
    assertCurrent = () => source.assertCurrent();
  } else {
    sourceHomeId = codexCatalogHomeId(codexHome);
  }
  if (expectedHomeId && expectedHomeId !== sourceHomeId) {
    throw new Error("Codex catalog source home changed. Reopen the session from the catalog.");
  }
  context?.signal?.throwIfAborted();
  const resumeKey = `${sourceHomeId}\0${sessionId}`;
  if (activeResumeSessions.has(resumeKey)) {
    throw new Error(`Codex CLI session ${sessionId} already has an active resume turn.`);
  }
  activeResumeSessions.add(resumeKey);
  try {
    const text = await runCodexExecResume({
      sessionId,
      prompt,
      cwd: typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : undefined,
      timeoutMs: normalizeTimeoutMs(params.timeoutMs),
      codexHome,
      assertCurrent,
      signal: context?.signal,
    });
    return JSON.stringify({
      ok: true,
      sessionId,
      text: text.trim() || "Codex completed without a text reply.",
    } satisfies CodexCliSessionResumeResult);
  } finally {
    activeResumeSessions.delete(resumeKey);
  }
}

async function runCodexExecResume(params: {
  sessionId: string;
  prompt: string;
  cwd?: string;
  timeoutMs: number;
  codexHome: string;
  assertCurrent?: () => void;
  signal?: AbortSignal;
}): Promise<string> {
  const outputPath = path.join(
    await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-codex-cli-")),
    "last-message.txt",
  );
  try {
    const args = [
      "exec",
      "resume",
      "--skip-git-repo-check",
      "--output-last-message",
      outputPath,
      params.sessionId,
      "-",
    ];
    const invocation = materializeWindowsSpawnProgram(
      resolveWindowsSpawnProgram({
        command: "codex",
        platform: process.platform,
        env: process.env,
        execPath: process.execPath,
        packageName: "@openai/codex",
      }),
      args,
    );
    const result = await withCommandProcessScope(() => {
      params.assertCurrent?.();
      return runCommandBuffered([invocation.command, ...invocation.argv], {
        cwd: params.cwd || process.cwd(),
        input: params.prompt,
        env: { ...process.env, CODEX_HOME: params.codexHome },
        killGraceMs: 2_000,
        signal: params.signal,
        terminateOnOutputError: true,
        timeoutMs: params.timeoutMs,
      });
    }, params.signal);
    params.signal?.throwIfAborted();
    if (result.termination === "timeout") {
      throw new Error(`codex exec resume timed out after ${String(params.timeoutMs)}ms`);
    }
    if (result.termination === "error" && result.error) {
      throw result.error;
    }
    if (result.code !== 0) {
      const message =
        result.stderr.toString("utf8").trim() ||
        result.stdout.toString("utf8").trim() ||
        `codex exec resume exited with code ${String(result.code)}`;
      throw new Error(message);
    }
    const text = await fs.readFile(outputPath, "utf8");
    params.signal?.throwIfAborted();
    return text;
  } finally {
    await fs.rm(path.dirname(outputPath), { recursive: true, force: true });
  }
}

async function readHistorySessions(
  codexHome: string,
): Promise<Map<string, CodexCliSessionSummary>> {
  const summaries = new Map<string, CodexCliSessionSummary>();
  const historyPath = path.join(codexHome, "history.jsonl");
  const result = await visitJsonlLines(historyPath, (line) => {
    const parsed = parseJsonRecord(line.trim());
    if (typeof parsed.session_id !== "string") {
      return;
    }
    const sessionId = parsed.session_id.trim();
    if (!sessionId) {
      return;
    }
    const entry = summaries.get(sessionId) ?? {
      sessionId,
      messageCount: 0,
    };
    entry.messageCount += 1;
    if (typeof parsed.text === "string" && parsed.text.trim()) {
      entry.lastMessage = truncateText(parsed.text.trim(), 140);
    }
    if (typeof parsed.ts === "number") {
      entry.updatedAt = timestampMsToIsoString(parsed.ts * 1000) ?? entry.updatedAt;
    }
    summaries.set(sessionId, entry);
  });
  if (!result.ok) {
    return new Map();
  }
  return summaries;
}

async function hydrateSessionsFromSessionFiles(
  codexHome: string,
  summaries: Map<string, CodexCliSessionSummary>,
): Promise<void> {
  const sessionsDir = path.join(codexHome, "sessions");
  const files = await findSessionFiles(sessionsDir, 4);
  for (const file of files) {
    const summary = await readSessionFileSummary(file);
    if (!summary) {
      continue;
    }
    const existing = summaries.get(summary.sessionId);
    summaries.set(summary.sessionId, {
      ...summary,
      ...existing,
      cwd: existing?.cwd ?? summary.cwd,
      sessionFile: existing?.sessionFile ?? summary.sessionFile,
      updatedAt: existing?.updatedAt ?? summary.updatedAt,
      lastMessage: existing?.lastMessage ?? summary.lastMessage,
      messageCount: existing?.messageCount ?? summary.messageCount,
    });
  }
}

async function readSessionFileSummary(file: string): Promise<CodexCliSessionSummary | null> {
  let sessionId = "";
  let cwd: string | undefined;
  let updatedAt: string | undefined;
  let lastMessage: string | undefined;
  let messageCount = 0;
  const result = await visitJsonlLines(file, (line) => {
    const parsed = parseJsonRecord(line.trim());
    if (typeof parsed.timestamp === "string" && parsed.timestamp.trim()) {
      updatedAt = parsed.timestamp.trim();
    }
    if (parsed.type === "session_meta" && isRecord(parsed.payload)) {
      if (typeof parsed.payload.id === "string" && parsed.payload.id.trim()) {
        sessionId = parsed.payload.id.trim();
      }
      if (typeof parsed.payload.cwd === "string" && parsed.payload.cwd.trim()) {
        cwd = parsed.payload.cwd.trim();
      }
      return;
    }
    const messageText = readResponseItemMessageText(parsed);
    if (messageText) {
      messageCount += 1;
      lastMessage = truncateText(messageText, 140);
    }
  });
  if (!result.ok || result.lineCount === 0) {
    return null;
  }
  if (!sessionId) {
    sessionId = readSessionIdFromFilename(file) ?? "";
  }
  if (!sessionId) {
    return null;
  }
  return {
    sessionId,
    updatedAt: updatedAt ?? (await readFileMtimeIso(file)),
    lastMessage,
    cwd,
    sessionFile: file,
    messageCount,
  };
}

async function findSessionFiles(dir: string, maxDepth: number): Promise<string[]> {
  if (maxDepth < 0) {
    return [];
  }
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findSessionFiles(entryPath, maxDepth - 1)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }
  return files;
}

function readResponseItemMessageText(parsed: Record<string, unknown>): string | undefined {
  if (
    parsed.type !== "response_item" ||
    !isRecord(parsed.payload) ||
    parsed.payload.type !== "message" ||
    parsed.payload.role !== "user"
  ) {
    return undefined;
  }
  const content = Array.isArray(parsed.payload.content) ? parsed.payload.content : [];
  const parts = content.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const text =
      typeof entry.text === "string"
        ? entry.text
        : typeof entry.input_text === "string"
          ? entry.input_text
          : undefined;
    return text?.trim() ? [text.trim()] : [];
  });
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function readSessionIdFromFilename(file: string): string | undefined {
  const match = path.basename(file).match(/[0-9a-f]{8}-[0-9a-f-]{27,}/iu);
  return match?.[0];
}

async function resolveCodexCliNode(params: {
  runtime: PluginRuntime;
  requestedNode?: string;
  command: string;
}): Promise<CodexCliSessionNodeInfo> {
  const list = await params.runtime.nodes.list(
    params.requestedNode ? undefined : { connected: true },
  );
  const requested = params.requestedNode?.trim();
  const candidates = list.nodes.filter((node) => {
    if (requested) {
      return [node.nodeId, node.displayName, node.remoteIp].some((value) => value === requested);
    }
    return node.connected === true && node.commands?.includes(params.command);
  });
  if (candidates.length === 0) {
    throw new Error(
      requested
        ? `Codex CLI node ${requested} was not found.`
        : "No connected node exposes Codex CLI session commands.",
    );
  }
  const usable = candidates.filter((node) => node.commands?.includes(params.command));
  if (usable.length === 0) {
    throw new Error(`Node ${requested ?? "candidate"} does not expose ${params.command}.`);
  }
  if (usable.length > 1) {
    throw new Error("Multiple Codex CLI-capable nodes connected. Pass --host <node-id>.");
  }
  return expectDefined(usable[0], "single usable Codex CLI node");
}

function parseCodexCliSessionsListResult(raw: unknown): CodexCliSessionsListResult {
  const payload = unwrapNodeInvokePayload(raw);
  if (!isRecord(payload) || !Array.isArray(payload.sessions)) {
    throw new Error("Codex CLI session list returned an invalid payload.");
  }
  return {
    codexHome: typeof payload.codexHome === "string" ? payload.codexHome : "",
    sessions: payload.sessions.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.sessionId !== "string") {
        return [];
      }
      return [
        {
          sessionId: entry.sessionId,
          updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : undefined,
          lastMessage: typeof entry.lastMessage === "string" ? entry.lastMessage : undefined,
          cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
          sessionFile: typeof entry.sessionFile === "string" ? entry.sessionFile : undefined,
          messageCount:
            typeof entry.messageCount === "number" && Number.isFinite(entry.messageCount)
              ? entry.messageCount
              : 0,
        },
      ];
    }),
  };
}

function unwrapNodeInvokePayload(raw: unknown): unknown {
  const record = isRecord(raw) ? raw : {};
  if (typeof record.payloadJSON === "string" && record.payloadJSON.trim()) {
    try {
      return JSON.parse(record.payloadJSON) as unknown;
    } catch (error) {
      throw new Error("Codex CLI node command returned malformed payloadJSON.", {
        cause: error,
      });
    }
  }
  if ("payload" in record) {
    return record.payload;
  }
  return raw;
}

function parseJsonRecord(paramsJSON?: string | null): Record<string, unknown> {
  if (!paramsJSON?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(paramsJSON) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readFileMtimeIso(file: string): Promise<string | undefined> {
  try {
    return (await fs.stat(file)).mtime.toISOString();
  } catch {
    return undefined;
  }
}

function normalizeLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_SESSION_LIMIT, Math.max(1, Math.floor(value)))
    : DEFAULT_SESSION_LIMIT;
}

function normalizeTimeoutMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(60 * 60_000, Math.floor(value))
    : DEFAULT_RESUME_TIMEOUT_MS;
}

function truncateText(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${truncateUtf16Safe(value, Math.max(0, max - 3))}...`;
}

function readNodeId(node: CodexCliSessionNodeInfo): string {
  if (!node.nodeId) {
    throw new Error("Codex CLI node did not include a node id.");
  }
  return node.nodeId;
}

function formatNodeLabel(node: CodexCliSessionNodeInfo): string {
  return [node.displayName, node.nodeId, node.remoteIp].filter(Boolean).join(" / ") || "node";
}
