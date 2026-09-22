// Codex plugin module implements node cli sessions behavior.
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { runCommandBuffered, withCommandProcessScope } from "openclaw/plugin-sdk/process-runtime";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import { resolveCodexAppServerUserHomeDir } from "./app-server/auth-start-options.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import {
  type CodexCliSessionSummary,
  findSessionFiles,
  hydrateSessionFiles,
  hydrateSessionsFromSessionFiles,
  matchesSessionFilter,
  readHistorySessions,
} from "./node-cli-session-files.js";
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

type CodexCliSessionsListResult = {
  sessions: CodexCliSessionSummary[];
  codexHome: string;
  /** Rollouts opened to build this listing. Absent from a node build that predates the counter. */
  scannedFileCount?: number;
  /** Rollouts present under the codex-home, whether or not they were opened. */
  sessionFileCount?: number;
  /**
   * Set when a filtered listing did not search the whole corpus — either rollouts were never
   * opened, or an opened rollout was too large to read whole and the part that went unread could
   * have matched. An unfiltered listing is a newest-first page by construction and never sets this.
   */
  searchTruncated?: boolean;
  /**
   * Rollouts that were opened, failed the filter on a windowed summary, and had an unread span the
   * filter term could be sitting in. Distinct from unopened files: the count is why an
   * every-file-opened search still cannot call itself complete.
   */
  unreadSpanCount?: number;
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
  /**
   * Opt out of the bounded scan: open every rollout under the codex-home and read each one whole.
   * This is what a user reruns with after the bounded search reported it stopped short, so a
   * directory or preview match past the candidate ceiling — or inside a span the read windows
   * skipped — stays reachable instead of being permanently dropped. It applies to a filtered
   * request only; an unfiltered listing is a newest-first page, not a search.
   */
  searchAll?: boolean;
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
      ...(params.searchAll ? { searchAll: true } : {}),
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
  const truncation = formatSessionSearchTruncation(params.result);
  if (params.result.sessions.length === 0) {
    // The empty answer is the one most likely to be read as "no such session exists", so a cut
    // search has to say so here too — returning early before the notice hid it exactly where it
    // mattered most.
    return [
      `No Codex CLI sessions returned from ${formatCodexDisplayText(formatNodeLabel(params.node))}.`,
      ...truncation,
    ].join("\n");
  }
  return [
    `Codex CLI sessions on ${formatCodexDisplayText(formatNodeLabel(params.node))}:`,
    ...truncation,
    ...params.result.sessions.map((session) => {
      // Say so when the preview and count come from a windowed read, so nobody reads a stale
      // `lastMessage` off an oversized rollout as that session's latest activity.
      const details = [
        session.cwd,
        session.updatedAt,
        session.partialScan ? "partial scan" : undefined,
      ].filter((value): value is string => Boolean(value));
      return `- ${formatCodexDisplayText(session.sessionId)}${
        session.lastMessage ? ` - ${formatCodexDisplayText(session.lastMessage)}` : ""
      }${details.length > 0 ? ` (${details.map(formatCodexDisplayText).join(", ")})` : ""}\n  Bind: /codex resume ${formatCodexDisplayText(
        session.sessionId,
      )} --host ${formatCodexDisplayText(readNodeId(params.node))} --bind here`;
    }),
  ].join("\n");
}

/**
 * A filter that stopped short is a search with sessions missing from it, not just a short page, so
 * say which part of the corpus was actually searched instead of presenting the cut set as the
 * whole answer.
 */
function formatSessionSearchTruncation(result: CodexCliSessionsListResult): string[] {
  if (!result.searchTruncated) {
    return [];
  }
  const scanned = result.scannedFileCount;
  const total = result.sessionFileCount;
  const unread = result.unreadSpanCount ?? 0;
  const sentences: string[] = [];
  // Not "the N most recent": a filtered scan reads filename matches before the rest, so the
  // rollouts it opened are not a recency prefix of the codex-home.
  if (scanned === undefined || total === undefined) {
    sentences.push(
      "Only part of this codex-home was searched; sessions matching on directory or message text may exist outside this list.",
    );
  } else if (scanned < total) {
    sentences.push(
      `Searched ${String(scanned)} of ${String(total)} rollouts; sessions matching on directory or message text may exist outside this list.`,
    );
  }
  // An opened rollout is not a read rollout. Reporting only the file count would let a search that
  // covered every file call itself complete while a match sat in a span it never looked at.
  if (unread > 0) {
    sentences.push(
      unread === 1
        ? "1 rollout was too large to read whole, so a directory or message-text match inside the part that went unread would not appear here."
        : `${String(unread)} rollouts were too large to read whole, so a directory or message-text match inside the parts that went unread would not appear here.`,
    );
  }
  sentences.push(
    "A session id is part of the rollout filename, so an id filter is read before the rest and reaches further back than a directory or message-text filter does.",
  );
  // Both causes above are the bounded scan's, and the complete search clears both: it opens every
  // rollout and reads each one whole. So the offer belongs on every truncated answer, not only on
  // the ones that ran out of candidates.
  sentences.push("Add --search-all to read every rollout on this node in full instead.");
  return [sentences.join(" ")];
}

async function listLocalCodexCliSessions(paramsJSON?: string | null): Promise<string> {
  const params = readRecordParam(paramsJSON);
  const limit = normalizeLimit(params.limit);
  const filter = typeof params.filter === "string" ? params.filter.trim().toLowerCase() : "";
  // Absent on a node build that predates the flag, which is the safe default: the bounded scan.
  const searchAll = params.searchAll === true;
  const codexHome = resolveCodexAppServerUserHomeDir();
  const summaries = await readHistorySessions(codexHome);
  const sessionFiles = await findSessionFiles(path.join(codexHome, "sessions"), 4);
  await hydrateSessionFiles(summaries, sessionFiles);
  const scan = await hydrateSessionsFromSessionFiles(summaries, sessionFiles, filter, limit, {
    searchAll,
  });
  const sessions = [...summaries.values()]
    .filter((session) => matchesSessionFilter(session, filter))
    .toSorted((a, b) => compareOptionalStringsDesc(a.updatedAt, b.updatedAt))
    .slice(0, limit);
  return JSON.stringify({
    sessions,
    codexHome,
    scannedFileCount: scan.scannedFileCount,
    sessionFileCount: sessionFiles.length,
    ...(scan.searchTruncated ? { searchTruncated: true } : {}),
    ...(scan.unreadSpanCount > 0 ? { unreadSpanCount: scan.unreadSpanCount } : {}),
  } satisfies CodexCliSessionsListResult);
}

async function resumeLocalCodexCliSession(
  paramsJSON: string | null | undefined,
  resolveCatalogSource: ResolveCatalogSource,
  context?: Parameters<OpenClawPluginNodeHostCommand["handle"]>[2],
): Promise<string> {
  context?.signal?.throwIfAborted();
  const params = readRecordParam(paramsJSON);
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
    // Keep these absent rather than zero when the node build predates them, so the truncation
    // notice falls back to its unquantified wording instead of claiming "0 of 0 rollouts".
    scannedFileCount: readOptionalCount(payload.scannedFileCount),
    sessionFileCount: readOptionalCount(payload.sessionFileCount),
    searchTruncated: payload.searchTruncated === true ? true : undefined,
    unreadSpanCount: readOptionalCount(payload.unreadSpanCount),
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
          messageCount: readFiniteCount(entry.messageCount),
          partialScan: entry.partialScan === true ? true : undefined,
        },
      ];
    }),
  };
}

function readFiniteCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readOptionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function readRecordParam(paramsJSON?: string | null): Record<string, unknown> {
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

function compareOptionalStringsDesc(a?: string, b?: string): number {
  return (b ?? "").localeCompare(a ?? "");
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
