import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  AssembleResult,
  ContextEngine,
  ContextEngineInfo,
  IngestResult,
} from "openclaw/plugin-sdk/context-engine";

export type OpenVikingWritebackMode = "session-api" | "workspace-memory" | "hybrid";

export type OpenVikingPluginConfig = {
  baseUrl?: string;
  account?: string;
  user?: string;
  agent?: string;
  targetUri?: string;
  limit?: number;
  scoreThreshold?: number;
  readLimit?: number;
  injectAbstractsOnly?: boolean;
  systemPromptHeader?: string;
  requestTimeoutMs?: number;
  logQueries?: boolean;
  logMisses?: boolean;
  logWriteback?: boolean;
  writebackEnabled?: boolean;
  writebackMode?: OpenVikingWritebackMode;
  writebackDirectory?: string;
  writebackIndexFile?: string;
  writebackMaxChars?: number;
  diagnosticEnabled?: boolean;
  diagnosticFile?: string;
};

type OpenVikingFindResponse = {
  status?: string;
  result?: {
    memories?: OpenVikingMatch[];
    resources?: OpenVikingMatch[];
    skills?: OpenVikingMatch[];
    total?: number;
  };
};

type OpenVikingReadResponse = {
  status?: string;
  result?: string | null;
};

type OpenVikingAbstractResponse = {
  status?: string;
  result?: string | null;
};

type OpenVikingMatch = {
  context_type?: string;
  uri?: string;
  level?: number;
  score?: number;
  abstract?: string | null;
  overview?: string | null;
};

type OpenVikingContextSnippet = {
  uri: string;
  score?: number;
  abstract?: string;
  text?: string;
};

type OpenVikingSessionCreateResponse = {
  session_id?: string;
  result?: {
    session_id?: string;
  };
};

type OpenVikingWritebackCandidate = {
  query: string;
  answer: string;
  digest: string;
};

type OpenVikingDiagnosticState = {
  updatedAt: string;
  sessionId: string;
  query?: string;
  resultCount?: number;
  targetUri?: string;
  retrievalOk?: boolean;
  retrievalError?: string;
  writebackEnabled: boolean;
  writebackMode?: OpenVikingWritebackMode;
  writebackOutcomes?: string[];
  writebackError?: string;
  writebackDigest?: string;
  writebackSkipped?: string;
};

type OpenVikingWritebackIndex = {
  digests: string[];
};

type OpenVikingLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:1933";
const DEFAULT_ACCOUNT = "default";
const DEFAULT_USER = "wuji";
const DEFAULT_AGENT = "openclaw";
const DEFAULT_TARGET_URI = "viking://resources";
const DEFAULT_LIMIT = 4;
const DEFAULT_READ_LIMIT = 80;
const DEFAULT_REQUEST_TIMEOUT_MS = 7_000;
const DEFAULT_SYSTEM_PROMPT_HEADER =
  "Retrieved context from OpenViking. Use it as supporting evidence, but prefer the current conversation if they conflict.";
const DEFAULT_WRITEBACK_DIRECTORY = "memory/openviking";
const DEFAULT_WRITEBACK_INDEX_FILE = "memory/openviking/_writeback-index.json";
const DEFAULT_WRITEBACK_MAX_CHARS = 800;
const DEFAULT_WRITEBACK_MODE: OpenVikingWritebackMode = "hybrid";
const DEFAULT_DIAGNOSTIC_FILE = "memory/openviking/_status.json";
const MAX_PERSISTED_WRITEBACK_DIGESTS = 256;

export class OpenVikingContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "openviking",
    name: "OpenViking Context Engine",
    version: "0.2.0",
  };

  private readonly recentWritebackDigests = new Set<string>();
  private readonly diagnosticStateBySession = new Map<string, OpenVikingDiagnosticState>();

  constructor(
    private readonly config: OpenVikingPluginConfig = {},
    private readonly logger?: OpenVikingLogger,
  ) {}

  async ingest(_params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: false };
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    const query = extractLatestUserQuery(params.messages);
    if (!query) {
      return { messages: params.messages, estimatedTokens: 0 };
    }
    let snippets: OpenVikingContextSnippet[] = [];
    try {
      snippets = await this.retrieveContext(query);
      this.rememberDiagnosticState(params.sessionId, {
        updatedAt: new Date().toISOString(),
        sessionId: params.sessionId,
        query,
        resultCount: snippets.length,
        targetUri: this.config.targetUri ?? DEFAULT_TARGET_URI,
        retrievalOk: true,
        writebackEnabled: Boolean(this.config.writebackEnabled),
        writebackMode: this.config.writebackMode ?? DEFAULT_WRITEBACK_MODE,
      });
    } catch (error) {
      this.logger?.warn?.(`openviking: retrieval failed: ${String(error)}`);
      this.rememberDiagnosticState(params.sessionId, {
        updatedAt: new Date().toISOString(),
        sessionId: params.sessionId,
        query,
        resultCount: 0,
        targetUri: this.config.targetUri ?? DEFAULT_TARGET_URI,
        retrievalOk: false,
        retrievalError: String(error),
        writebackEnabled: Boolean(this.config.writebackEnabled),
        writebackMode: this.config.writebackMode ?? DEFAULT_WRITEBACK_MODE,
      });
      return { messages: params.messages, estimatedTokens: 0 };
    }
    if (this.config.logQueries) {
      this.logger?.info?.(
        `openviking: query="${truncateForLog(query)}" results=${snippets.length} target=${this.config.targetUri ?? DEFAULT_TARGET_URI}`,
      );
    } else if (snippets.length === 0 && this.config.logMisses) {
      this.logger?.info?.(`openviking: miss for query="${truncateForLog(query)}"`);
    }
    if (snippets.length === 0) {
      return { messages: params.messages, estimatedTokens: 0 };
    }
    return {
      messages: params.messages,
      estimatedTokens: estimateSnippetTokens(snippets),
      systemPromptAddition: buildSystemPromptAddition({
        header: this.config.systemPromptHeader ?? DEFAULT_SYSTEM_PROMPT_HEADER,
        query,
        snippets,
      }),
    };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.config.writebackEnabled || params.isHeartbeat) {
      await this.writeDiagnosticSnapshotBestEffort(params);
      return;
    }

    const newMessages = params.messages.slice(params.prePromptMessageCount);
    const candidate = extractWritebackCandidate(newMessages, this.config.writebackMaxChars);
    if (!candidate) {
      return;
    }
    const mode = this.config.writebackMode ?? DEFAULT_WRITEBACK_MODE;
    const workspaceDir = resolveRuntimeWorkspaceDir(params.runtimeContext);
    const persistentDuplicate =
      workspaceDir != null
        ? await this.hasPersistedWritebackDigest(workspaceDir, candidate.digest)
        : false;
    if (this.recentWritebackDigests.has(candidate.digest)) {
      if (this.config.logWriteback) {
        this.logger?.debug?.(`openviking: writeback skipped duplicate digest=${candidate.digest}`);
      }
      this.rememberDiagnosticState(params.sessionId, {
        updatedAt: new Date().toISOString(),
        sessionId: params.sessionId,
        query: candidate.query,
        writebackEnabled: true,
        writebackMode: mode,
        writebackDigest: candidate.digest,
        writebackSkipped: "duplicate digest (process cache)",
        writebackError: undefined,
        writebackOutcomes: undefined,
      });
      await this.writeDiagnosticSnapshotBestEffort(params);
      return;
    }
    if (persistentDuplicate) {
      if (this.config.logWriteback) {
        this.logger?.debug?.(
          `openviking: writeback skipped duplicate digest=${candidate.digest} (persisted index)`,
        );
      }
      this.rememberWritebackDigest(candidate.digest);
      this.rememberDiagnosticState(params.sessionId, {
        updatedAt: new Date().toISOString(),
        sessionId: params.sessionId,
        query: candidate.query,
        writebackEnabled: true,
        writebackMode: mode,
        writebackDigest: candidate.digest,
        writebackSkipped: "duplicate digest (persisted index)",
        writebackError: undefined,
        writebackOutcomes: undefined,
      });
      await this.writeDiagnosticSnapshotBestEffort(params);
      return;
    }

    const outcomes: string[] = [];
    let sessionApiError: unknown;
    let workspaceError: unknown;

    if (mode === "session-api" || mode === "hybrid") {
      try {
        const sessionId = await this.createSession();
        await this.addSessionMessage(sessionId, "user", candidate.query);
        await this.addSessionMessage(sessionId, "assistant", candidate.answer);
        await this.commitSession(sessionId);
        outcomes.push(`session-api:${sessionId}`);
      } catch (error) {
        sessionApiError = error;
        this.logger?.warn?.(`openviking: session-api writeback failed: ${String(error)}`);
      }
    }

    if (mode === "workspace-memory" || mode === "hybrid") {
      try {
        if (workspaceDir) {
          const filePath = await this.writeWorkspaceMemory({
            workspaceDir,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            candidate,
          });
          outcomes.push(`workspace:${filePath}`);
        } else {
          workspaceError = new Error("missing runtimeContext.workspaceDir");
          this.logger?.warn?.(
            "openviking: workspace-memory writeback skipped: missing workspaceDir",
          );
        }
      } catch (error) {
        workspaceError = error;
        this.logger?.warn?.(`openviking: workspace-memory writeback failed: ${String(error)}`);
      }
    }

    if (outcomes.length === 0) {
      this.rememberDiagnosticState(params.sessionId, {
        updatedAt: new Date().toISOString(),
        sessionId: params.sessionId,
        writebackEnabled: true,
        writebackMode: mode,
        writebackError: String(sessionApiError ?? workspaceError ?? "OpenViking writeback failed"),
      });
      await this.writeDiagnosticSnapshotBestEffort(params);
      throw sessionApiError ?? workspaceError ?? new Error("OpenViking writeback failed");
    }

    this.rememberWritebackDigest(candidate.digest);
    if (workspaceDir) {
      await this.persistWritebackDigest(workspaceDir, candidate.digest);
    }
    this.rememberDiagnosticState(params.sessionId, {
      updatedAt: new Date().toISOString(),
      sessionId: params.sessionId,
      query: candidate.query,
      writebackEnabled: true,
      writebackMode: mode,
      writebackOutcomes: outcomes,
      writebackDigest: candidate.digest,
      writebackSkipped: undefined,
      writebackError: undefined,
    });
    await this.writeDiagnosticSnapshotBestEffort(params);
    if (this.config.logWriteback) {
      this.logger?.info?.(
        `openviking: writeback stored digest=${candidate.digest} via ${outcomes.join(", ")}`,
      );
    }
  }

  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }) {
    return {
      ok: true,
      compacted: false,
      reason: "OpenViking delegates compaction to the legacy pipeline for now.",
      result: {
        tokensBefore: params.currentTokenCount ?? 0,
      },
    };
  }

  private async retrieveContext(query: string): Promise<OpenVikingContextSnippet[]> {
    const matches = await this.find(query);
    const snippets: OpenVikingContextSnippet[] = [];
    for (const match of matches) {
      if (!match.uri) {
        continue;
      }
      const abstract = cleanText(match.abstract ?? match.overview ?? undefined);
      const text = this.config.injectAbstractsOnly
        ? undefined
        : await this.readBestEffort(match.uri, abstract);
      snippets.push({
        uri: match.uri,
        score: match.score,
        abstract,
        text,
      });
    }
    return snippets.filter((snippet) => Boolean(snippet.abstract || snippet.text));
  }

  private async find(query: string): Promise<OpenVikingMatch[]> {
    const response = await this.requestJson<OpenVikingFindResponse>("/api/v1/search/find", {
      method: "POST",
      body: JSON.stringify({
        query,
        target_uri: this.config.targetUri ?? DEFAULT_TARGET_URI,
        limit: this.config.limit ?? DEFAULT_LIMIT,
        score_threshold: this.config.scoreThreshold,
      }),
    });
    const result = response.result;
    return [...(result?.memories ?? []), ...(result?.resources ?? []), ...(result?.skills ?? [])];
  }

  private async readBestEffort(
    uri: string,
    fallbackAbstract?: string,
  ): Promise<string | undefined> {
    const readResult = await this.requestJson<OpenVikingReadResponse>(
      `/api/v1/content/read?${new URLSearchParams({
        uri,
        offset: "0",
        limit: String(this.config.readLimit ?? DEFAULT_READ_LIMIT),
      }).toString()}`,
    );
    const text = cleanText(readResult.result ?? undefined);
    if (text) {
      return text;
    }
    const abstractResult = await this.requestJson<OpenVikingAbstractResponse>(
      `/api/v1/content/abstract?${new URLSearchParams({ uri }).toString()}`,
    );
    return cleanText(abstractResult.result ?? fallbackAbstract);
  }

  private async requestJson<T>(pathname: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(
      `${normalizeBaseUrl(this.config.baseUrl ?? DEFAULT_BASE_URL)}${pathname}`,
      {
        ...init,
        signal: controller.signal,
        headers: {
          "X-OpenViking-Account": this.config.account ?? DEFAULT_ACCOUNT,
          "X-OpenViking-User": this.config.user ?? DEFAULT_USER,
          "X-OpenViking-Agent": this.config.agent ?? DEFAULT_AGENT,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...(init?.headers ?? {}),
        },
      },
    );
    clearTimeout(timeout);
    if (!response.ok) {
      throw new Error(`OpenViking request failed (${response.status} ${response.statusText})`);
    }
    return (await response.json()) as T;
  }

  private async createSession(): Promise<string> {
    const response = await this.requestJson<OpenVikingSessionCreateResponse>("/api/v1/sessions", {
      method: "POST",
    });
    const sessionId = response.result?.session_id ?? response.session_id;
    if (!sessionId) {
      throw new Error("OpenViking session create response missing session_id");
    }
    return sessionId;
  }

  private async addSessionMessage(
    sessionId: string,
    role: "user" | "assistant",
    content: string,
  ): Promise<void> {
    await this.requestJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        role,
        content,
      }),
    });
  }

  private async commitSession(sessionId: string): Promise<void> {
    await this.requestJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/commit?wait=false`, {
      method: "POST",
      body: JSON.stringify({ telemetry: false }),
    });
  }

  private async writeWorkspaceMemory(params: {
    workspaceDir: string;
    sessionId: string;
    sessionKey?: string;
    candidate: OpenVikingWritebackCandidate;
  }): Promise<string> {
    const relativePath = buildWritebackRelativePath(
      this.config.writebackDirectory ?? DEFAULT_WRITEBACK_DIRECTORY,
      new Date(),
    );
    const filePath = resolveWorkspaceChild(params.workspaceDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const marker = `<!-- openviking-writeback:${params.candidate.digest} -->`;
    let existing = "";
    try {
      existing = await fs.readFile(filePath, "utf-8");
      if (existing.includes(marker)) {
        return relativePath;
      }
    } catch {
      // File does not exist yet.
    }

    const block = buildWorkspaceWritebackBlock({
      marker,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      query: params.candidate.query,
      answer: params.candidate.answer,
      timestamp: new Date(),
    });
    const prefix = existing.trim().length > 0 ? "\n\n" : "";
    await fs.appendFile(filePath, `${prefix}${block}`, "utf-8");
    return relativePath;
  }

  private rememberWritebackDigest(digest: string): void {
    this.recentWritebackDigests.add(digest);
    if (this.recentWritebackDigests.size <= 128) {
      return;
    }
    const oldest = this.recentWritebackDigests.values().next().value;
    if (oldest) {
      this.recentWritebackDigests.delete(oldest);
    }
  }

  private rememberDiagnosticState(sessionId: string, next: OpenVikingDiagnosticState): void {
    const previous = this.diagnosticStateBySession.get(sessionId);
    this.diagnosticStateBySession.set(sessionId, {
      ...previous,
      ...next,
    });
    if (this.diagnosticStateBySession.size <= 64) {
      return;
    }
    const oldest = this.diagnosticStateBySession.keys().next().value;
    if (oldest) {
      this.diagnosticStateBySession.delete(oldest);
    }
  }

  private async hasPersistedWritebackDigest(
    workspaceDir: string,
    digest: string,
  ): Promise<boolean> {
    const digests = await this.readPersistedWritebackDigests(workspaceDir);
    return digests.includes(digest);
  }

  private async persistWritebackDigest(workspaceDir: string, digest: string): Promise<void> {
    const existing = await this.readPersistedWritebackDigests(workspaceDir);
    const next = [...existing.filter((entry) => entry !== digest), digest].slice(
      -MAX_PERSISTED_WRITEBACK_DIGESTS,
    );
    const filePath = resolveWorkspaceChild(
      workspaceDir,
      ensureNativeMemoryRelativePath(
        this.config.writebackIndexFile ?? DEFAULT_WRITEBACK_INDEX_FILE,
        "writebackIndexFile",
      ),
    );
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload: OpenVikingWritebackIndex = { digests: next };
    await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    await fs.rename(`${filePath}.tmp`, filePath);
  }

  private async readPersistedWritebackDigests(workspaceDir: string): Promise<string[]> {
    let filePath: string;
    try {
      filePath = resolveWorkspaceChild(
        workspaceDir,
        ensureNativeMemoryRelativePath(
          this.config.writebackIndexFile ?? DEFAULT_WRITEBACK_INDEX_FILE,
          "writebackIndexFile",
        ),
      );
    } catch (error) {
      this.logger?.warn?.(`openviking: writeback index skipped: ${String(error)}`);
      return [];
    }

    try {
      const raw = JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
      if (
        typeof raw === "object" &&
        raw !== null &&
        Array.isArray((raw as { digests?: unknown }).digests)
      ) {
        return (raw as { digests: unknown[] }).digests.filter(
          (entry): entry is string => typeof entry === "string" && entry.length > 0,
        );
      }
      this.logger?.warn?.("openviking: writeback index unreadable: invalid JSON shape");
      return [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      this.logger?.warn?.(`openviking: writeback index unreadable: ${String(error)}`);
      return [];
    }
  }

  private async writeDiagnosticSnapshotBestEffort(params: {
    sessionId: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<void> {
    if (this.config.diagnosticEnabled === false) {
      return;
    }
    const workspaceDir = resolveRuntimeWorkspaceDir(params.runtimeContext);
    if (!workspaceDir) {
      return;
    }
    let filePath: string;
    try {
      filePath = resolveWorkspaceChild(
        workspaceDir,
        ensureNativeMemoryRelativePath(
          this.config.diagnosticFile ?? DEFAULT_DIAGNOSTIC_FILE,
          "diagnosticFile",
        ),
      );
    } catch (error) {
      this.logger?.warn?.(`openviking: diagnostic snapshot skipped: ${String(error)}`);
      return;
    }
    const snapshot = this.diagnosticStateBySession.get(params.sessionId);
    if (!snapshot) {
      return;
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(`${filePath}.tmp`, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
    await fs.rename(`${filePath}.tmp`, filePath);
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function extractLatestUserQuery(messages: AgentMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      !message ||
      typeof message !== "object" ||
      !("role" in message) ||
      message.role !== "user"
    ) {
      continue;
    }
    const text = extractTextContent((message as { content?: unknown }).content);
    if (text) {
      return text;
    }
  }
  return null;
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const candidate = item as { type?: unknown; text?: unknown; content?: unknown };
      if (candidate.type === "text" && typeof candidate.text === "string") {
        return candidate.text;
      }
      if (typeof candidate.content === "string") {
        return candidate.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function buildSystemPromptAddition(params: {
  header: string;
  query: string;
  snippets: OpenVikingContextSnippet[];
}): string {
  const blocks = params.snippets
    .map((snippet, index) => {
      const parts = [
        `Result ${index + 1}: ${snippet.uri}`,
        typeof snippet.score === "number" ? `Score: ${snippet.score.toFixed(3)}` : null,
        snippet.abstract ? `Abstract:\n${snippet.abstract}` : null,
        snippet.text ? `Excerpt:\n${snippet.text}` : null,
      ].filter(Boolean);
      return parts.join("\n");
    })
    .join("\n\n");
  return `${params.header}\n\nUser query:\n${params.query}\n\n${blocks}`;
}

function cleanText(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function estimateSnippetTokens(snippets: OpenVikingContextSnippet[]): number {
  const chars = snippets.reduce((total, snippet) => {
    return total + (snippet.abstract?.length ?? 0) + (snippet.text?.length ?? 0);
  }, 0);
  return Math.ceil(chars / 4);
}

export function extractWritebackCandidate(
  messages: AgentMessage[],
  maxChars: number = DEFAULT_WRITEBACK_MAX_CHARS,
): OpenVikingWritebackCandidate | null {
  const turn = extractLatestTurn(messages);
  if (!turn?.query || !turn.answer) {
    return null;
  }
  const query = trimForWriteback(turn.query, maxChars);
  const answer = trimForWriteback(turn.answer, maxChars);
  if (!query || !answer) {
    return null;
  }
  return {
    query,
    answer,
    digest: createWritebackDigest(query, answer),
  };
}

export function extractLatestTurn(
  messages: AgentMessage[],
): { query?: string; answer?: string } | null {
  let latestAssistant: string | undefined;
  let latestUser: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || !("role" in message)) {
      continue;
    }
    const role = message.role;
    const text = extractTextContent((message as { content?: unknown }).content);
    if (!text) {
      continue;
    }
    if (!latestAssistant && role === "assistant") {
      latestAssistant = text;
      continue;
    }
    if (latestAssistant && role === "user") {
      latestUser = text;
      break;
    }
  }
  if (!latestAssistant && !latestUser) {
    return null;
  }
  return {
    query: latestUser,
    answer: latestAssistant,
  };
}

export function createWritebackDigest(query: string, answer: string): string {
  return createHash("sha1").update(`${query}\n---\n${answer}`).digest("hex").slice(0, 12);
}

export function buildWritebackRelativePath(directory: string, now: Date): string {
  const normalizedDirectory = ensureNativeMemoryRelativePath(directory, "writebackDirectory");
  return `${normalizedDirectory}/${formatLocalDate(now)}.md`;
}

export function resolveWorkspaceChild(workspaceDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error("writebackDirectory must be workspace-relative");
  }
  const resolved = path.resolve(workspaceDir, relativePath);
  const relative = path.relative(workspaceDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`writeback path escapes workspace: ${relativePath}`);
  }
  return resolved;
}

export function buildWorkspaceWritebackBlock(params: {
  marker: string;
  sessionId: string;
  sessionKey?: string;
  query: string;
  answer: string;
  timestamp: Date;
}): string {
  const lines = [
    params.marker,
    `## ${params.timestamp.toISOString()}`,
    "",
    `- Session: ${params.sessionId}`,
    params.sessionKey ? `- Session Key: ${params.sessionKey}` : null,
    "",
    "### User",
    params.query,
    "",
    "### Assistant",
    params.answer,
  ].filter((line): line is string => typeof line === "string");
  return lines.join("\n");
}

function resolveRuntimeWorkspaceDir(runtimeContext?: Record<string, unknown>): string | undefined {
  const candidate = runtimeContext?.workspaceDir;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function ensureNativeMemoryRelativePath(value: string, label: string): string {
  const normalized = value.replace(/^\/+/, "").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments[0] !== "memory") {
    throw new Error(`${label} must stay under memory/`);
  }
  if (segments.some((segment) => segment === ".obsidian")) {
    throw new Error(`${label} must not target .obsidian`);
  }
  return segments.join("/");
}

function formatLocalDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function trimForWriteback(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function truncateForLog(value: string, maxChars: number = 120): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
