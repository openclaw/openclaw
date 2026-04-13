import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ErrorSeed, ScannerState } from "./types.js";
import { agentDataRoot, atomicWriteJson, ensureDir, nowIso, readJson } from "./utils.js";

const MAX_ERROR_MESSAGE_LEN = 500;
const FINGERPRINT_LEN = 16;

/** Default location for the per-agent session log directory. */
export function sessionsDir(agent: string): string {
  return path.join(os.homedir(), ".openclaw", "agents", agent, "sessions");
}

/** Override-aware variant: opts.sessionsRoot lets tests inject a fake dir. */
export function resolveSessionsDir(agent: string, sessionsRoot?: string): string {
  if (sessionsRoot && sessionsRoot.length > 0) {
    return path.join(sessionsRoot, agent, "sessions");
  }
  return sessionsDir(agent);
}

export function errorSeedsDir(root?: string): string {
  return path.join(agentDataRoot(root), "shared", "lessons", "error-seeds");
}

export function scannerStatePath(root?: string): string {
  return path.join(agentDataRoot(root), "shared", "lessons", "scanner-state.json");
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Compute the deterministic fingerprint for (agent, tool, errorClass). */
export function errorFingerprint(agent: string, tool: string, errorClass: string): string {
  return sha256Hex(`${agent}:${tool}:${errorClass}`).slice(0, FINGERPRINT_LEN);
}

const KNOWN_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /permission denied/i, label: "Permission denied" },
  { re: /file not found|no such file or directory|enoent/i, label: "File not found" },
  { re: /timeout|timed out|etimedout/i, label: "Timeout" },
  { re: /rate limit/i, label: "Rate limit" },
  { re: /connection refused|econnrefused/i, label: "Connection refused" },
  { re: /unauthorized|401/i, label: "Unauthorized" },
  { re: /forbidden|403/i, label: "Forbidden" },
  { re: /not found|404/i, label: "Not found" },
];

/** Normalize a free-form error message into a short class label. */
export function classifyError(message: string): string {
  const trimmed = (message ?? "").toString().trim();
  if (!trimmed) return "Unknown error";
  for (const { re, label } of KNOWN_PATTERNS) {
    if (re.test(trimmed)) return label;
  }
  // First sentence (split on . ! ? newline) or first 80 chars.
  const firstLine = trimmed.split(/[\r\n]/, 1)[0] ?? trimmed;
  const firstSentence = firstLine.split(/[.!?]/, 1)[0] ?? firstLine;
  const candidate = firstSentence.trim();
  if (candidate.length === 0) return trimmed.slice(0, 80);
  return candidate.length > 80 ? candidate.slice(0, 80) : candidate;
}

/** Auto-derive domain tags for a tool + error message. */
export function deriveDomainTags(tool: string): string[] {
  const tags = new Set<string>();
  const t = (tool ?? "").toString();
  const lower = t.toLowerCase();
  if (lower === "message" || lower.startsWith("feishu_") || lower.startsWith("feishu.")) {
    tags.add("messaging");
    tags.add("feishu");
  }
  if (lower === "exec" || lower === "bash" || lower === "shell") {
    tags.add("shell");
    tags.add("cli");
  }
  if (lower === "read" || lower === "write" || lower === "edit") {
    tags.add("filesystem");
  }
  if (lower === "gh" || lower.startsWith("gh_") || lower.startsWith("github")) {
    tags.add("github");
    tags.add("ci-cd");
  }
  if (t.startsWith("mcp__openclaw__")) {
    const stripped = t.slice("mcp__openclaw__".length);
    if (stripped) tags.add(stripped);
  }
  tags.add("error-capture");
  return Array.from(tags).sort();
}

interface ParsedToolResult {
  tool: string;
  message: string;
  isErrorRecord: boolean;
  timestamp: string;
}

function isJsonString(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object" && (c as { type?: string }).type === "text") {
      const text = (c as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

function tsToIso(ts: unknown, fallback: string): string {
  if (typeof ts === "number" && Number.isFinite(ts)) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof ts === "string" && ts.length > 0) {
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return fallback;
}

/** Try to extract an error from a single toolResult message envelope. */
function parseToolResult(record: unknown, fallbackTs: string): ParsedToolResult | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  if (r.type !== "message") return null;
  const msg = r.message as Record<string, unknown> | undefined;
  if (!msg || msg.role !== "toolResult") return null;
  const tool =
    (typeof msg.toolName === "string" ? msg.toolName : undefined) ??
    (() => {
      const d = msg.details as Record<string, unknown> | undefined;
      return d && typeof d.tool === "string" ? d.tool : "unknown";
    })();
  const details = msg.details as Record<string, unknown> | undefined;
  const detailsStatus = details?.status;
  const detailsError = details?.error;
  const isError = msg.isError === true;
  const text = extractText(msg.content);
  let isErrorRecord = isError || detailsStatus === "error";
  let errorMessage = "";
  if (typeof detailsError === "string" && detailsError.length > 0) {
    errorMessage = detailsError;
  }
  if (text && isJsonString(text)) {
    const parsed = tryParseJson(text);
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      if (p.status === "error" || (typeof p.error === "string" && p.error.length > 0)) {
        isErrorRecord = true;
        if (!errorMessage) {
          if (typeof p.error === "string") errorMessage = p.error;
          else if (typeof p.message === "string") errorMessage = p.message;
        }
      }
    }
  }
  if (!isErrorRecord) return null;
  if (!errorMessage) errorMessage = text || "Unknown error";
  return {
    tool: String(tool),
    message: errorMessage.slice(0, MAX_ERROR_MESSAGE_LEN),
    isErrorRecord: true,
    timestamp: tsToIso(msg.timestamp ?? r.timestamp, fallbackTs),
  };
}

interface SessionHeader {
  id: string;
  timestamp: string;
}

function parseSessionHeader(record: unknown): SessionHeader | null {
  if (!record || typeof record !== "object") return null;
  const r = record as Record<string, unknown>;
  if (r.type !== "session") return null;
  const id = typeof r.id === "string" ? r.id : "";
  const timestamp = typeof r.timestamp === "string" ? r.timestamp : "";
  if (!id) return null;
  return { id, timestamp: timestamp || nowIso() };
}

/** Scan a single session JSONL file. Returns the list of error seeds found. */
export function scanSession(sessionPath: string, agent: string): ErrorSeed[] {
  if (!fs.existsSync(sessionPath)) return [];
  const raw = fs.readFileSync(sessionPath, "utf8");
  const lines = raw.split(/\r?\n/);
  let header: SessionHeader | null = null;
  const seeds: ErrorSeed[] = [];
  // Fallback session key derived from the file name if no header is present.
  const fileBase = path.basename(sessionPath).replace(/\.jsonl$/i, "");
  for (const line of lines) {
    if (!line.trim()) continue;
    const record = tryParseJson(line);
    if (!record) continue;
    if (!header) {
      header = parseSessionHeader(record);
      if (header) continue;
    }
    const sessionKey = header?.id ?? fileBase;
    const sessionTimestamp = header?.timestamp ?? nowIso();
    const result = parseToolResult(record, sessionTimestamp);
    if (!result) continue;
    const errorClass = classifyError(result.message);
    const fingerprint = errorFingerprint(agent, result.tool, errorClass);
    seeds.push({
      sessionKey,
      agent,
      tool: result.tool,
      errorClass,
      errorMessage: result.message,
      fingerprint,
      domainTags: deriveDomainTags(result.tool),
      timestamp: result.timestamp,
      sessionTimestamp,
    });
  }
  return seeds;
}

export interface ScanAgentOptions {
  root?: string;
  sessionsRoot?: string;
  state?: ScannerState;
}

export interface ScanAgentResult {
  seeds: ErrorSeed[];
  newSessions: string[];
}

function ensureState(state?: ScannerState): ScannerState {
  if (state && state.version === 1 && state.scannedSessions) return state;
  return {
    version: 1,
    lastScanAt: nowIso(),
    scannedSessions: {},
  };
}

/** Scan every untouched session file under one agent's session dir. */
export function scanAgent(agent: string, opts: ScanAgentOptions = {}): ScanAgentResult {
  const dir = resolveSessionsDir(agent, opts.sessionsRoot);
  if (!fs.existsSync(dir)) return { seeds: [], newSessions: [] };
  const state = ensureState(opts.state);
  const already = new Set(state.scannedSessions[agent] ?? []);
  const entries = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  const seeds: ErrorSeed[] = [];
  const newSessions: string[] = [];
  for (const name of entries) {
    const full = path.join(dir, name);
    const sessionSeeds = scanSession(full, agent);
    // Determine session key (header id when present, else file base).
    const key = sessionSeeds[0]?.sessionKey ?? name.replace(/\.jsonl$/i, "");
    if (already.has(key)) continue;
    seeds.push(...sessionSeeds);
    newSessions.push(key);
  }
  return { seeds, newSessions };
}

export interface ScanAllOptions {
  agents?: string[];
  root?: string;
  sessionsRoot?: string;
  state?: ScannerState;
  now?: Date;
}

export interface ScanAllResult {
  seeds: ErrorSeed[];
  updatedState: ScannerState;
}

/** Scan every agent and produce an updated scanner state. */
export function scanAll(opts: ScanAllOptions = {}): ScanAllResult {
  const agents = opts.agents ?? ["builder", "architect", "chief", "growth"];
  const state = ensureState(opts.state ?? readScannerStateOrEmpty(opts.root));
  const now = opts.now ?? new Date();
  const seeds: ErrorSeed[] = [];
  for (const agent of agents) {
    const r = scanAgent(agent, {
      root: opts.root,
      sessionsRoot: opts.sessionsRoot,
      state,
    });
    seeds.push(...r.seeds);
    if (r.newSessions.length > 0) {
      const prior = state.scannedSessions[agent] ?? [];
      state.scannedSessions[agent] = Array.from(new Set([...prior, ...r.newSessions])).sort();
    }
  }
  state.lastScanAt = nowIso(now);
  return { seeds, updatedState: state };
}

/** Append seeds to today's daily JSONL bucket and return the file path. */
export function writeSeedsAppend(seeds: ErrorSeed[], root?: string, now?: Date): string {
  const date = (now ?? new Date()).toISOString().slice(0, 10);
  const dir = errorSeedsDir(root);
  ensureDir(dir);
  const file = path.join(dir, `${date}.jsonl`);
  if (seeds.length === 0) return file;
  const lines = seeds.map((s) => JSON.stringify(s)).join("\n");
  fs.appendFileSync(file, lines + "\n", { encoding: "utf8" });
  return file;
}

/** Read all persisted error seeds from the error-seeds/ directory. */
export function readPersistedSeeds(root?: string): ErrorSeed[] {
  const dir = errorSeedsDir(root);
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const seeds: ErrorSeed[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        seeds.push(JSON.parse(line) as ErrorSeed);
      } catch {
        /* skip malformed */
      }
    }
  }
  return seeds;
}

function readScannerStateOrEmpty(root?: string): ScannerState {
  const filePath = scannerStatePath(root);
  if (!fs.existsSync(filePath)) return ensureState();
  try {
    const parsed = readJson<ScannerState>(filePath);
    return ensureState(parsed);
  } catch {
    return ensureState();
  }
}

export function readScannerState(root?: string): ScannerState {
  return readScannerStateOrEmpty(root);
}

export function writeScannerState(state: ScannerState, root?: string): void {
  const filePath = scannerStatePath(root);
  atomicWriteJson(filePath, state);
}
