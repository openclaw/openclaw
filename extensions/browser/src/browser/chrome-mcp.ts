import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { normalizeOptionalString, readStringValue } from "openclaw/plugin-sdk/text-runtime";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { asRecord } from "../record-shared.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";
import type { BrowserTab } from "./client.types.js";
import { BrowserProfileUnavailableError, BrowserTabNotFoundError } from "./errors.js";

const log = createSubsystemLogger("browser").child("chrome-mcp");

type ChromeMcpStructuredPage = {
  id: number;
  url?: string;
  selected?: boolean;
};

type ChromeMcpToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
};

type ChromeMcpSession = {
  client: Client;
  transport: StdioClientTransport;
  ready: Promise<void>;
};

type ChromeMcpCallOptions = {
  ephemeral?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ChromeMcpProfileOptions = {
  userDataDir?: string;
  cdpUrl?: string;
  mcpCommand?: string;
  mcpArgs?: string[];
};

type NormalizedChromeMcpProfileOptions = {
  userDataDir?: string;
  browserUrl?: string;
  command: string;
  extraArgs: string[];
};
type ChromeMcpOptionsInput = string | ChromeMcpProfileOptions | NormalizedChromeMcpProfileOptions;

type ChromeMcpSessionLease = {
  session: ChromeMcpSession;
  cacheKey: string;
  temporary: boolean;
};

type ChromeMcpSessionFactory = (
  profileName: string,
  options?: NormalizedChromeMcpProfileOptions,
) => Promise<ChromeMcpSession>;

const DEFAULT_CHROME_MCP_COMMAND = "npx";
const DEFAULT_CHROME_MCP_PACKAGE_ARGS = ["-y", "chrome-devtools-mcp@latest"];
const DEFAULT_CHROME_MCP_FEATURE_ARGS = [
  // Direct chrome-devtools-mcp launches do not enable structuredContent by default.
  "--experimentalStructuredContent",
  "--experimental-page-id-routing",
];
const CHROME_MCP_CONNECTION_FLAGS = new Set([
  "--autoConnect",
  "--auto-connect",
  "--browserUrl",
  "--browser-url",
  "--wsEndpoint",
  "--ws-endpoint",
  "-w",
]);
const CHROME_MCP_USER_DATA_DIR_FLAGS = new Set(["--userDataDir", "--user-data-dir"]);
const CHROME_MCP_NEW_PAGE_TIMEOUT_MS = 5_000;
const CHROME_MCP_NAVIGATE_TIMEOUT_MS = 20_000;
const CHROME_MCP_HANDSHAKE_TIMEOUT_MS = 30_000;
const CHROME_MCP_STDERR_MAX_BYTES = 8 * 1024;
const STALE_SELECTED_PAGE_ERROR =
  "The selected page has been closed. Call list_pages to see open pages.";

const sessions = new Map<string, ChromeMcpSession>();
const pendingSessions = new Map<string, Promise<ChromeMcpSession>>();
const sessionReadyState = new WeakMap<ChromeMcpSession, "pending" | "ready" | "failed">();
let sessionFactory: ChromeMcpSessionFactory | null = null;

function trackSessionReadyState(session: ChromeMcpSession): void {
  if (sessionReadyState.has(session)) {
    return;
  }
  sessionReadyState.set(session, "pending");
  session.ready.then(
    () => {
      if (sessionReadyState.get(session) === "pending") {
        sessionReadyState.set(session, "ready");
      }
    },
    () => {
      if (sessionReadyState.get(session) === "pending") {
        sessionReadyState.set(session, "failed");
      }
    },
  );
}

function asPages(value: unknown): ChromeMcpStructuredPage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ChromeMcpStructuredPage[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record || typeof record.id !== "number") {
      continue;
    }
    out.push({
      id: record.id,
      url: readStringValue(record.url),
      selected: record.selected === true,
    });
  }
  return out;
}

function parsePageId(targetId: string): number {
  const parsed = Number.parseInt(targetId.trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new BrowserTabNotFoundError();
  }
  return parsed;
}

function toBrowserTabs(pages: ChromeMcpStructuredPage[]): BrowserTab[] {
  return pages.map((page) => ({
    targetId: String(page.id),
    title: "",
    url: page.url ?? "",
    type: "page",
  }));
}

function extractStructuredContent(result: ChromeMcpToolResult): Record<string, unknown> {
  return asRecord(result.structuredContent) ?? {};
}

function extractTextContent(result: ChromeMcpToolResult): string[] {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((entry) => {
      const record = asRecord(entry);
      return record && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean);
}

function extractTextPages(result: ChromeMcpToolResult): ChromeMcpStructuredPage[] {
  const pages: ChromeMcpStructuredPage[] = [];
  for (const block of extractTextContent(result)) {
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+):\s+(.+?)(?:\s+\[(selected)\])?\s*$/i);
      if (!match) {
        continue;
      }
      pages.push({
        id: Number.parseInt(match[1] ?? "", 10),
        url: normalizeOptionalString(match[2]),
        selected: Boolean(match[3]),
      });
    }
  }
  return pages;
}

function extractStructuredPages(result: ChromeMcpToolResult): ChromeMcpStructuredPage[] {
  const structured = asPages(extractStructuredContent(result).pages);
  return structured.length > 0 ? structured : extractTextPages(result);
}

function extractSnapshot(result: ChromeMcpToolResult): ChromeMcpSnapshotNode {
  const structured = extractStructuredContent(result);
  const snapshot = asRecord(structured.snapshot);
  if (!snapshot) {
    throw new Error("Chrome MCP snapshot response was missing structured snapshot data.");
  }
  return snapshot as unknown as ChromeMcpSnapshotNode;
}

function extractJsonBlock(text: string): unknown {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const raw = match?.[1]?.trim() || text.trim();
  return raw ? JSON.parse(raw) : null;
}

function extractMessageText(result: ChromeMcpToolResult): string {
  const message = extractStructuredContent(result).message;
  if (typeof message === "string" && message.trim()) {
    return message;
  }
  const blocks = extractTextContent(result);
  return blocks.find((block) => block.trim()) ?? "";
}

function extractToolErrorMessage(result: ChromeMcpToolResult, name: string): string {
  const message = extractMessageText(result).trim();
  return message || `Chrome MCP tool "${name}" failed.`;
}

function shouldReconnectForToolError(name: string, message: string): boolean {
  return name === "list_pages" && message.includes(STALE_SELECTED_PAGE_ERROR);
}

function extractJsonMessage(result: ChromeMcpToolResult): unknown {
  const candidates = [extractMessageText(result), ...extractTextContent(result)].filter((text) =>
    text.trim(),
  );
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return extractJsonBlock(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

function normalizeChromeMcpUserDataDir(userDataDir?: string): string | undefined {
  const trimmed = userDataDir?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeChromeMcpStringList(values?: string[]): string[] {
  return Array.isArray(values)
    ? values.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
}

function normalizeChromeMcpOptions(
  input?: ChromeMcpOptionsInput,
): NormalizedChromeMcpProfileOptions {
  if (typeof input === "object" && input && "command" in input && "extraArgs" in input) {
    return input;
  }
  const options = typeof input === "string" ? { userDataDir: input } : (input ?? {});
  const command = normalizeOptionalString(options.mcpCommand) ?? DEFAULT_CHROME_MCP_COMMAND;
  return {
    command,
    userDataDir: normalizeChromeMcpUserDataDir(options.userDataDir),
    browserUrl: normalizeOptionalString(options.cdpUrl),
    extraArgs: normalizeChromeMcpStringList(options.mcpArgs),
  };
}

function hasFlag(args: string[], flags: Set<string>): boolean {
  return args.some((arg) => {
    const [name] = arg.split("=", 1);
    return flags.has(name ?? arg);
  });
}

function isChromeMcpWebSocketEndpoint(url: string): boolean {
  return /^wss?:\/\//i.test(url);
}

function buildChromeMcpConnectionArgs(options: NormalizedChromeMcpProfileOptions): string[] {
  if (hasFlag(options.extraArgs, CHROME_MCP_CONNECTION_FLAGS)) {
    return [];
  }
  if (options.browserUrl) {
    return isChromeMcpWebSocketEndpoint(options.browserUrl)
      ? ["--wsEndpoint", options.browserUrl]
      : ["--browserUrl", options.browserUrl];
  }
  return ["--autoConnect"];
}

function buildChromeMcpUserDataDirArgs(options: NormalizedChromeMcpProfileOptions): string[] {
  if (
    !options.userDataDir ||
    options.browserUrl ||
    hasFlag(options.extraArgs, CHROME_MCP_CONNECTION_FLAGS) ||
    hasFlag(options.extraArgs, CHROME_MCP_USER_DATA_DIR_FLAGS)
  ) {
    return [];
  }
  return ["--userDataDir", options.userDataDir];
}

function buildChromeMcpSessionCacheKey(
  profileName: string,
  options: NormalizedChromeMcpProfileOptions,
): string {
  return JSON.stringify([
    profileName,
    options.userDataDir ?? "",
    options.browserUrl ?? "",
    options.command,
    options.extraArgs,
  ]);
}

function chromeMcpProfileOptionsFromParams(params: {
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
}): string | ChromeMcpProfileOptions | undefined {
  return params.profile ?? params.userDataDir;
}

function cacheKeyMatchesProfileName(cacheKey: string, profileName: string): boolean {
  try {
    const parsed = JSON.parse(cacheKey);
    return Array.isArray(parsed) && parsed[0] === profileName;
  } catch {
    return false;
  }
}

async function closeChromeMcpSessionsForProfile(
  profileName: string,
  keepKey?: string,
): Promise<boolean> {
  let closed = false;

  for (const key of Array.from(pendingSessions.keys())) {
    if (key !== keepKey && cacheKeyMatchesProfileName(key, profileName)) {
      pendingSessions.delete(key);
      closed = true;
    }
  }

  for (const [key, session] of Array.from(sessions.entries())) {
    if (key !== keepKey && cacheKeyMatchesProfileName(key, profileName)) {
      sessions.delete(key);
      closed = true;
      await session.client.close().catch(() => {});
    }
  }

  return closed;
}

function buildChromeMcpArgsFromOptions(options: NormalizedChromeMcpProfileOptions): string[] {
  const commandPrefix =
    options.command === DEFAULT_CHROME_MCP_COMMAND ? DEFAULT_CHROME_MCP_PACKAGE_ARGS : [];
  return [
    ...commandPrefix,
    ...buildChromeMcpConnectionArgs(options),
    ...DEFAULT_CHROME_MCP_FEATURE_ARGS,
    ...buildChromeMcpUserDataDirArgs(options),
    ...options.extraArgs,
  ];
}

export function buildChromeMcpArgs(input?: string | ChromeMcpProfileOptions): string[] {
  return buildChromeMcpArgsFromOptions(normalizeChromeMcpOptions(input));
}

function drainStderr(transport: StdioClientTransport): () => string {
  const stream = transport.stderr;
  if (!stream) {
    return () => "";
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  stream.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const capped =
      buffer.length > CHROME_MCP_STDERR_MAX_BYTES
        ? buffer.subarray(buffer.length - CHROME_MCP_STDERR_MAX_BYTES)
        : buffer;
    chunks.push(capped);
    totalBytes += capped.length;
    while (totalBytes > CHROME_MCP_STDERR_MAX_BYTES && chunks.length > 1) {
      const dropped = chunks.shift();
      if (dropped) {
        totalBytes -= dropped.length;
      }
    }
  });
  stream.on("error", () => {});
  return () => Buffer.concat(chunks).toString("utf8").trim().slice(-CHROME_MCP_STDERR_MAX_BYTES);
}

async function withChromeMcpHandshakeTimeout<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Chrome MCP handshake timed out")),
          CHROME_MCP_HANDSHAKE_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function createRealSession(
  profileName: string,
  options: NormalizedChromeMcpProfileOptions = normalizeChromeMcpOptions(),
): Promise<ChromeMcpSession> {
  const transport = new StdioClientTransport({
    command: options.command,
    args: buildChromeMcpArgsFromOptions(options),
    stderr: "pipe",
  });
  const client = new Client(
    {
      name: "openclaw-browser",
      version: "0.0.0",
    },
    {},
  );

  let getStderr = () => "";
  const ready = (async () => {
    try {
      await withChromeMcpHandshakeTimeout(
        (async () => {
          await client.connect(transport);
          getStderr = drainStderr(transport);
          const tools = await client.listTools();
          if (!tools.tools.some((tool) => tool.name === "list_pages")) {
            throw new Error("Chrome MCP server did not expose the expected navigation tools.");
          }
        })(),
      );
    } catch (err) {
      await client.close().catch(() => {});
      const stderr = getStderr();
      if (stderr) {
        log.warn(
          `Chrome MCP attach failed for profile "${profileName}". Subprocess stderr:\n${stderr}`,
        );
      }
      const targetLabel = options.browserUrl
        ? `the configured Chrome endpoint (${options.browserUrl})`
        : options.userDataDir
          ? `the configured Chromium user data dir (${options.userDataDir})`
          : "Google Chrome's default profile";
      throw new BrowserProfileUnavailableError(
        `Chrome MCP existing-session attach failed for profile "${profileName}". ` +
          `Make sure ${targetLabel} is running locally with remote debugging enabled. ` +
          `Details: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
  ready.catch(() => {});

  return {
    client,
    transport,
    ready,
  };
}

async function waitForChromeMcpReady(
  session: ChromeMcpSession,
  profileName: string,
  timeoutMs?: number,
): Promise<void> {
  if (!timeoutMs || timeoutMs <= 0) {
    await session.ready;
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new BrowserProfileUnavailableError(
              `Chrome MCP existing-session attach for profile "${profileName}" timed out after ${timeoutMs}ms.`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function getSession(
  profileName: string,
  profileOptions?: ChromeMcpOptionsInput,
  timeoutMs?: number,
): Promise<ChromeMcpSession> {
  const options = normalizeChromeMcpOptions(profileOptions);
  const cacheKey = buildChromeMcpSessionCacheKey(profileName, options);
  await closeChromeMcpSessionsForProfile(profileName, cacheKey);

  let session = sessions.get(cacheKey);
  if (session && session.transport.pid === null) {
    sessions.delete(cacheKey);
    session = undefined;
  }
  if (!session) {
    let pending = pendingSessions.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const created = await (sessionFactory ?? createRealSession)(profileName, options);
        trackSessionReadyState(created);
        if (pendingSessions.get(cacheKey) === pending) {
          sessions.set(cacheKey, created);
        } else {
          await created.client.close().catch(() => {});
        }
        return created;
      })();
      pendingSessions.set(cacheKey, pending);
    }
    try {
      session = await pending;
    } finally {
      if (pendingSessions.get(cacheKey) === pending) {
        pendingSessions.delete(cacheKey);
      }
    }
  }
  try {
    await waitForChromeMcpReady(session, profileName, timeoutMs);
    return session;
  } catch (err) {
    const current = sessions.get(cacheKey);
    if (current?.transport === session.transport) {
      sessions.delete(cacheKey);
    }
    throw err;
  }
}

async function getExistingSession(
  cacheKey: string,
  profileName: string,
  timeoutMs?: number,
): Promise<ChromeMcpSession | null> {
  let session = sessions.get(cacheKey);
  if (session && session.transport.pid === null) {
    sessions.delete(cacheKey);
    session = undefined;
  }
  if (session) {
    try {
      await waitForChromeMcpReady(session, profileName, timeoutMs);
      return session;
    } catch (err) {
      const current = sessions.get(cacheKey);
      if (current?.transport === session.transport) {
        sessions.delete(cacheKey);
      }
      throw err;
    }
  }

  const pending = pendingSessions.get(cacheKey);
  if (!pending) {
    return null;
  }

  session = await pending;
  try {
    await waitForChromeMcpReady(session, profileName, timeoutMs);
    return session;
  } catch (err) {
    const current = sessions.get(cacheKey);
    if (current?.transport === session.transport) {
      sessions.delete(cacheKey);
    }
    throw err;
  }
}

async function createEphemeralSession(
  profileName: string,
  profileOptions?: ChromeMcpOptionsInput,
  timeoutMs?: number,
): Promise<ChromeMcpSession> {
  const options = normalizeChromeMcpOptions(profileOptions);
  const session = await (sessionFactory ?? createRealSession)(profileName, options);
  try {
    await waitForChromeMcpReady(session, profileName, timeoutMs);
    return session;
  } catch (err) {
    await session.client.close().catch(() => {});
    throw err;
  }
}

async function leaseSession(
  profileName: string,
  profileOptions?: ChromeMcpOptionsInput,
  options: ChromeMcpCallOptions = {},
): Promise<ChromeMcpSessionLease> {
  const normalizedProfileOptions = normalizeChromeMcpOptions(profileOptions);
  const cacheKey = buildChromeMcpSessionCacheKey(profileName, normalizedProfileOptions);
  if (!options.ephemeral) {
    return {
      session: await getSession(profileName, normalizedProfileOptions, options.timeoutMs),
      cacheKey,
      temporary: false,
    };
  }

  // Status probes should avoid seeding the shared attach session cache, but they can safely
  // reuse a real cached session if one already exists.
  const existingSession = await getExistingSession(cacheKey, profileName, options.timeoutMs);
  if (existingSession) {
    return {
      session: existingSession,
      cacheKey,
      temporary: false,
    };
  }

  return {
    session: await createEphemeralSession(profileName, normalizedProfileOptions, options.timeoutMs),
    cacheKey,
    temporary: true,
  };
}

async function callTool(
  profileName: string,
  profileOptions: ChromeMcpOptionsInput | undefined,
  name: string,
  args: Record<string, unknown> = {},
  options: ChromeMcpCallOptions = {},
): Promise<ChromeMcpToolResult> {
  const timeoutMs = options.timeoutMs;
  const signal = options.signal;
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lease = await leaseSession(profileName, profileOptions, options);
    const rawCall = lease.session.client.callTool({
      name,
      arguments: args,
    }) as Promise<ChromeMcpToolResult>;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const racers: Array<Promise<ChromeMcpToolResult> | Promise<never>> = [rawCall];

    if (timeoutMs !== undefined && timeoutMs > 0) {
      racers.push(
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new Error(
                `Chrome MCP "${name}" timed out after ${timeoutMs}ms. Session reset for reconnect.`,
              ),
            );
          }, timeoutMs);
        }),
      );
    }

    if (signal) {
      racers.push(
        new Promise<never>((_, reject) => {
          abortListener = () => reject(signal.reason ?? new Error("aborted"));
          signal.addEventListener("abort", abortListener, { once: true });
        }),
      );
    }

    let result: ChromeMcpToolResult;
    try {
      result = racers.length === 1 ? await rawCall : await Promise.race(racers);
    } catch (err) {
      void rawCall.catch(() => {});
      // Transport/connection error, timeout, or abort: tear down session so it reconnects.
      // Transport-identity check prevents clobbering a replacement session created concurrently.
      if (!lease.temporary) {
        const cur = sessions.get(lease.cacheKey);
        if (cur?.transport === lease.session.transport) {
          sessions.delete(lease.cacheKey);
          await lease.session.client.close().catch(() => {});
        }
      }
      throw err;
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      if (lease.temporary) {
        await lease.session.client.close().catch(() => {});
      }
    }
    // Tool-level errors (element not found, script error, etc.) don't indicate a
    // broken connection. A stale selected-page error does poison the Chrome MCP
    // session, so reconnect and retry that one once.
    if (result.isError) {
      const message = extractToolErrorMessage(result, name);
      if (shouldReconnectForToolError(name, message)) {
        if (!lease.temporary) {
          const cur = sessions.get(lease.cacheKey);
          if (cur?.transport === lease.session.transport) {
            sessions.delete(lease.cacheKey);
            await lease.session.client.close().catch(() => {});
          }
        }
        if (attempt === 0) {
          continue;
        }
      }
      throw new Error(message);
    }
    return result;
  }
  throw new Error(`Chrome MCP tool "${name}" failed after reconnect.`);
}

async function withTempFile<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-chrome-mcp-"));
  const filePath = path.join(dir, randomUUID());
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function findPageById(
  profileName: string,
  pageId: number,
  profileOptions?: string | ChromeMcpProfileOptions,
): Promise<ChromeMcpStructuredPage> {
  const pages = await listChromeMcpPages(profileName, profileOptions);
  const page = pages.find((entry) => entry.id === pageId);
  if (!page) {
    throw new BrowserTabNotFoundError();
  }
  return page;
}

export async function ensureChromeMcpAvailable(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpCallOptions = {},
): Promise<void> {
  // Defense-in-depth: never spawn chrome-devtools-mcp from cold cache while
  // Chrome is in a state where re-spawning would re-fire the macOS automation
  // consent dialog (HIGH attached, MEDIUM uncertain, or LOW with conflicting
  // signals). The gate is bypassed only when there is no Chrome remote
  // debugging session at all (`emptyState`) — in which case spawning the
  // chrome-mcp child to bring one up is the legitimate caller intent.
  const cacheKey = buildChromeMcpSessionCacheKey(
    profileName,
    normalizeChromeMcpOptions(profileOptions),
  );
  const cached = sessions.get(cacheKey);
  const cacheReady =
    !!cached && cached.transport.pid != null && sessionReadyState.get(cached) === "ready";
  if (!cacheReady) {
    const health = await probeChromeMcpHealth(profileName, profileOptions);
    if (!health.cacheAttached) {
      const gate = decideStartGate(health);
      if (!gate.mayStart) {
        throw new BrowserProfileUnavailableError(
          formatStartGateBlockedMessage(profileName, health, gate),
        );
      }
    }
  }
  const lease = await leaseSession(profileName, profileOptions, options);
  if (lease.temporary) {
    await lease.session.client.close().catch(() => {});
  }
}

export function getChromeMcpPid(profileName: string): number | null {
  for (const [key, session] of sessions.entries()) {
    if (cacheKeyMatchesProfileName(key, profileName)) {
      return session.transport.pid ?? null;
    }
  }
  return null;
}

export type ChromeRemoteDebuggingFileSignal = {
  /** Toggle present, port file present, port currently listening on loopback. */
  enabled: boolean;
  /** Local State `devtools.remote_debugging.user-enabled` was true. */
  toggleEnabled: boolean;
  port: number | null;
  browserUuid: string | null;
  /** TCP loopback connect to `port` succeeded within the probe timeout. */
  portListening: boolean;
  reason: string;
};

export type ChromeRemoteDebuggingProbeInput = {
  userDataDir?: string;
  cdpUrl?: string;
};

const CHROME_REMOTE_DEBUGGING_PORT_PROBE_TIMEOUT_MS = 200;
const CHROME_REMOTE_DEBUGGING_HTTP_PROBE_TIMEOUT_MS = 200;
const CHROME_REMOTE_DEBUGGING_LSOF_TIMEOUT_MS = 500;
const CHROME_PROCESS_NAMES_LOWER = [
  "google chrome",
  "chromium",
  "chrome beta",
  "chrome canary",
  "chrome dev",
  "google chrome beta",
  "google chrome canary",
  "google chrome dev",
];

/**
 * Returns the macOS Chrome user-data directory, or null on other platforms.
 * Linux (`~/.config/google-chrome`) and Windows
 * (`%LOCALAPPDATA%\Google\Chrome\User Data`) can be added later behind
 * platform checks; chrome-devtools-mcp autoConnect targets the same path.
 */
export function getChromeUserDataDir(profileUserDataDir?: string): string | null {
  if (profileUserDataDir) {
    return profileUserDataDir;
  }
  if (process.platform !== "darwin") {
    return null;
  }
  const home = process.env.HOME;
  if (!home) {
    return null;
  }
  return path.join(home, "Library", "Application Support", "Google", "Chrome");
}

async function probeTcpListening(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/**
 * File-based detection for "Chrome is in remote-debugging mode and a CDP
 * server is bound." Reads the user's `Local State` toggle and the active
 * `DevToolsActivePort` written by Chrome, and TCP-probes the port to rule
 * out stale files. The returned record is intentionally granular so the
 * confidence aggregator can distinguish empty state from contradictory
 * state without re-reading the same files.
 */
export async function probeChromeRemoteDebuggingViaFiles(
  input: ChromeRemoteDebuggingProbeInput = {},
): Promise<ChromeRemoteDebuggingFileSignal> {
  const empty: ChromeRemoteDebuggingFileSignal = {
    enabled: false,
    toggleEnabled: false,
    port: null,
    browserUuid: null,
    portListening: false,
    reason: "",
  };
  if (input.cdpUrl) {
    return { ...empty, reason: "cdp-url-configured" };
  }
  const dir = getChromeUserDataDir(input.userDataDir);
  if (!dir) {
    return { ...empty, reason: "user-data-dir-unresolved" };
  }
  let toggleEnabled = false;
  let localStateReadable = true;
  try {
    const text = await fs.readFile(path.join(dir, "Local State"), "utf8");
    const parsed = JSON.parse(text) as unknown;
    const root = asRecord(parsed);
    const devtools = asRecord(root?.devtools);
    const remoteDebugging = asRecord(devtools?.remote_debugging);
    toggleEnabled = remoteDebugging?.["user-enabled"] === true;
  } catch {
    localStateReadable = false;
  }
  let port: number | null = null;
  let browserUuid: string | null = null;
  let portFileReadable = true;
  let portFileParseable = true;
  try {
    const filePath = path.join(dir, "DevToolsActivePort");
    const text = await fs.readFile(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    const parsedPort = Number.parseInt(lines[0]?.trim() ?? "", 10);
    if (Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
      port = parsedPort;
    } else {
      portFileParseable = false;
    }
    const uuidMatch = lines[1]?.trim().match(/^\/devtools\/browser\/(.+)$/);
    if (uuidMatch?.[1]) {
      browserUuid = uuidMatch[1];
    }
  } catch {
    portFileReadable = false;
  }
  let portListening = false;
  if (port !== null) {
    portListening = await probeTcpListening(
      "127.0.0.1",
      port,
      CHROME_REMOTE_DEBUGGING_PORT_PROBE_TIMEOUT_MS,
    );
  }
  let reason: string;
  if (!localStateReadable) {
    reason = "local-state-unreadable";
  } else if (!toggleEnabled && !portFileReadable) {
    reason = "user-enabled-false";
  } else if (!toggleEnabled) {
    reason = "toggle-off-port-file-present";
  } else if (!portFileReadable) {
    reason = "devtools-active-port-unreadable";
  } else if (!portFileParseable) {
    reason = "devtools-active-port-unparseable";
  } else if (!portListening) {
    reason = "devtools-active-port-not-listening";
  } else {
    reason = "devtools-active-port-detected";
  }
  return {
    enabled: toggleEnabled && portListening && port !== null,
    toggleEnabled,
    port,
    browserUuid,
    portListening,
    reason,
  };
}

type ChromeRemoteDebuggingProber = (
  input: ChromeRemoteDebuggingProbeInput,
) => Promise<ChromeRemoteDebuggingFileSignal>;

const CHROME_REMOTE_DEBUGGING_PROBER_DISABLED: ChromeRemoteDebuggingProber = async () => ({
  enabled: false,
  toggleEnabled: false,
  port: null,
  browserUuid: null,
  portListening: false,
  reason: "test-disabled",
});

let chromeRemoteDebuggingProber: ChromeRemoteDebuggingProber = probeChromeRemoteDebuggingViaFiles;

export function setChromeRemoteDebuggingProberForTest(
  prober: ChromeRemoteDebuggingProber | null,
): void {
  chromeRemoteDebuggingProber = prober ?? probeChromeRemoteDebuggingViaFiles;
}

export type ChromePortOwnerKind = "chrome" | "other" | "none" | "unknown";

export type ChromePortOwnerSignal = {
  kind: ChromePortOwnerKind;
  process?: string;
  pid?: number;
  reason: string;
};

/**
 * Best-effort port-owner check via `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
 * macOS only. Returns `unknown` rather than `none` when lsof is unavailable
 * or the call times out, so the confidence aggregator can downgrade to
 * MEDIUM instead of falsely concluding the port is free.
 */
export async function probeChromePortOwner(port: number): Promise<ChromePortOwnerSignal> {
  if (process.platform !== "darwin") {
    return { kind: "unknown", reason: "platform-unsupported" };
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { kind: "unknown", reason: "invalid-port" };
  }
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let timedOut = false;
  try {
    await new Promise<void>((resolve) => {
      const child = spawn("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: "pipe" });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, CHROME_REMOTE_DEBUGGING_LSOF_TIMEOUT_MS);
      timer.unref?.();
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("close", (code) => {
        exitCode = typeof code === "number" ? code : null;
        clearTimeout(timer);
        resolve();
      });
    });
  } catch {
    return { kind: "unknown", reason: "lsof-spawn-failed" };
  }
  if (timedOut) {
    return { kind: "unknown", reason: "lsof-timeout" };
  }
  if (exitCode === 1 && stdout.trim() === "") {
    return { kind: "none", reason: "lsof-no-listener" };
  }
  if (exitCode !== 0 && exitCode !== 1) {
    return { kind: "unknown", reason: `lsof-exit-${exitCode ?? "unknown"}` };
  }
  void stderr;
  // First line is a header. Each subsequent row is whitespace-delimited:
  // COMMAND  PID  USER  FD  TYPE  DEVICE  SIZE/OFF  NODE  NAME
  // COMMAND can contain spaces (e.g. "Google Chrome"), so we instead pull
  // the PID column (right-aligned digits) and infer COMMAND from the prefix.
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const dataLines = lines.slice(1);
  if (dataLines.length === 0) {
    return { kind: "none", reason: "lsof-no-listener" };
  }
  for (const line of dataLines) {
    const pidMatch = line.match(/^(.+?)\s+(\d+)\s+\S+\s+\d+u?\s+IPv/);
    if (!pidMatch) {
      continue;
    }
    const command = pidMatch[1]?.trim() ?? "";
    const pid = Number.parseInt(pidMatch[2] ?? "", 10);
    const lower = command.toLowerCase();
    if (CHROME_PROCESS_NAMES_LOWER.some((name) => lower.startsWith(name))) {
      return {
        kind: "chrome",
        process: command,
        ...(Number.isFinite(pid) ? { pid } : {}),
        reason: "lsof-chrome-listener",
      };
    }
    return {
      kind: "other",
      process: command,
      ...(Number.isFinite(pid) ? { pid } : {}),
      reason: "lsof-non-chrome-listener",
    };
  }
  return { kind: "unknown", reason: "lsof-unparseable" };
}

export type ChromeJsonVersionSignal = {
  ok: boolean;
  reason: string;
  product?: string;
};

/**
 * Best-effort `GET http://127.0.0.1:<port>/json/version`. Used as a
 * confirmatory signal for HIGH confidence; never used as a primary gate
 * because some build flavors of Chrome restrict the HTTP endpoint to
 * loopback-from-127.0.0.1 with `--remote-allow-origins`.
 */
export async function probeChromeJsonVersion(port: number): Promise<ChromeJsonVersionSignal> {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { ok: false, reason: "invalid-port" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHROME_REMOTE_DEBUGGING_HTTP_PROBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
      headers: { Host: "localhost" },
    });
    if (!res.ok) {
      return { ok: false, reason: `http-${res.status}` };
    }
    const body = (await res.json()) as unknown;
    const record = asRecord(body);
    const product = typeof record?.["Browser"] === "string" ? record["Browser"] : "";
    if (/chrome|chromium/i.test(product)) {
      return { ok: true, reason: "chrome-json-version", product };
    }
    return { ok: false, reason: "non-chrome-product", product };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { ok: false, reason: "http-timeout" };
    }
    return { ok: false, reason: "http-error" };
  } finally {
    clearTimeout(timer);
  }
}

export type BrowserAuthSignalProbes = {
  fileProbe: ChromeRemoteDebuggingProber;
  portOwnerProbe: (port: number) => Promise<ChromePortOwnerSignal>;
  jsonVersionProbe: (port: number) => Promise<ChromeJsonVersionSignal>;
};

const DEFAULT_SIGNAL_PROBES: BrowserAuthSignalProbes = {
  fileProbe: (input) => chromeRemoteDebuggingProber(input),
  portOwnerProbe: probeChromePortOwner,
  jsonVersionProbe: probeChromeJsonVersion,
};

let signalProbes: BrowserAuthSignalProbes = DEFAULT_SIGNAL_PROBES;

export function setBrowserAuthSignalProbesForTest(
  probes: Partial<BrowserAuthSignalProbes> | null,
): void {
  if (!probes) {
    signalProbes = DEFAULT_SIGNAL_PROBES;
    return;
  }
  signalProbes = { ...signalProbes, ...probes };
}

export type ChromeBrowserAuthLevel = "high" | "medium" | "low";

export type ChromeBrowserAuthHealth = {
  level: ChromeBrowserAuthLevel;
  /** True iff `level === "high"`. Preserves the pre-confidence API contract. */
  attached: boolean;
  /** Pid of the cached chrome-devtools-mcp child, when HIGH was decided via cache. */
  mcpPid: number | null;
  port: number | null;
  browserUuid: string | null;
  /** Ordered, deterministic list of the per-signal reasons that produced `level`. */
  reasons: string[];
  /**
   * True iff: Local State toggle is FALSE *and* no listener owns the
   * candidate port. Only this combination clears LOW for `mayStart: true`.
   */
  emptyState: boolean;
  /** True iff HIGH was decided from a live, ready chrome-devtools-mcp child. */
  cacheAttached: boolean;
};

export type StartGateDecision =
  | { mayStart: true; reason: string }
  | { mayStart: false; reason: string; level: ChromeBrowserAuthLevel };

/**
 * Visual auth verifier. Wired here as a typed extension point so the
 * MEDIUM-confidence path can be lifted to HIGH (or held as MEDIUM with a
 * specific reason) once peekaboo / vision plumbing lands. The default
 * verifier is `null`; callers must register one explicitly.
 */
export interface BrowserAuthVisualVerifier {
  /** Detects the macOS "Allow remote debugging?" / consent modal. */
  checkConsentModal(input: {
    profileName: string;
    port: number | null;
  }): Promise<{ present: boolean; reason: string }>;
  /** Detects the "controlled by automated test software" banner. */
  checkAutomationBanner(input: {
    profileName: string;
    port: number | null;
  }): Promise<{ present: boolean; reason: string }>;
}

let browserAuthVisualVerifier: BrowserAuthVisualVerifier | null = null;

export function setBrowserAuthVisualVerifier(verifier: BrowserAuthVisualVerifier | null): void {
  browserAuthVisualVerifier = verifier;
}

export function getBrowserAuthVisualVerifier(): BrowserAuthVisualVerifier | null {
  return browserAuthVisualVerifier;
}

/**
 * Aggregates file, port-owner, and HTTP signals into a single confidence
 * verdict. Used by `probeChromeMcpHealth` and consumed by `decideStartGate`.
 *
 * Decision matrix (after the MCP cache miss):
 *
 *   HIGH:    toggle=on  port=listening  owner=chrome           (HTTP confirms when reachable)
 *   MEDIUM:  toggle=on  port=listening  owner=unknown
 *            toggle=on  port-file=missing                       (Chrome may be relaunching)
 *            toggle=on  port=listening  owner=chrome  HTTP=404  (build-restricted endpoint)
 *   LOW:     toggle=off port=none       owner=none              (truly empty → may start)
 *            toggle=on  port=stale/!listening                   (contradiction → may not start)
 *            toggle=*   owner=other                             (someone else owns the port)
 */
async function computeBrowserAuthConfidence(
  input: ChromeRemoteDebuggingProbeInput,
): Promise<Omit<ChromeBrowserAuthHealth, "cacheAttached" | "mcpPid">> {
  const file = await signalProbes.fileProbe(input);
  const reasons: string[] = [`file:${file.reason}`];
  if (file.reason === "cdp-url-configured" || file.reason === "user-data-dir-unresolved") {
    return {
      level: "low",
      attached: false,
      port: null,
      browserUuid: null,
      reasons,
      emptyState: true,
    };
  }
  let owner: ChromePortOwnerSignal | null = null;
  if (file.port !== null) {
    owner = await signalProbes.portOwnerProbe(file.port);
    reasons.push(`owner:${owner.reason}`);
  } else {
    reasons.push("owner:no-port");
  }
  if (owner && owner.kind === "other") {
    return {
      level: "low",
      attached: false,
      port: file.port,
      browserUuid: file.browserUuid,
      reasons,
      emptyState: false,
    };
  }
  if (!file.toggleEnabled) {
    const ownerNone = !owner || owner.kind === "none";
    return {
      level: "low",
      attached: false,
      port: file.port,
      browserUuid: file.browserUuid,
      reasons,
      emptyState: ownerNone && !file.portListening,
    };
  }
  if (file.port === null) {
    return {
      level: "medium",
      attached: false,
      port: null,
      browserUuid: file.browserUuid,
      reasons,
      emptyState: false,
    };
  }
  if (!file.portListening) {
    return {
      level: "low",
      attached: false,
      port: file.port,
      browserUuid: file.browserUuid,
      reasons,
      emptyState: false,
    };
  }
  if (!owner || owner.kind !== "chrome") {
    return {
      level: "medium",
      attached: false,
      port: file.port,
      browserUuid: file.browserUuid,
      reasons,
      emptyState: false,
    };
  }
  const json = await signalProbes.jsonVersionProbe(file.port);
  reasons.push(`http:${json.reason}`);
  if (json.ok) {
    return {
      level: "high",
      attached: true,
      port: file.port,
      browserUuid: file.browserUuid,
      reasons,
      emptyState: false,
    };
  }
  return {
    level: "medium",
    attached: false,
    port: file.port,
    browserUuid: file.browserUuid,
    reasons,
    emptyState: false,
  };
}

/**
 * Confidence-gated, non-spawning health probe for the Chrome MCP transport.
 *
 * Reports `level: "high", attached: true` when either (1) the in-process
 * session cache holds a ready chrome-devtools-mcp child, or (2) the file +
 * port-owner + HTTP probes all agree the user has remote debugging on and
 * a Chrome process owns the listening CDP port. Reports MEDIUM/LOW with
 * `attached: false` for any partial / contradictory state. Never calls
 * getSession, never spawns, and never awaits a still-pending session —
 * callers (status polls, listProfiles, GET /tabs, ensureBrowserAvailable)
 * must not be able to trigger a fresh chrome-devtools-mcp spawn that would
 * re-pop the macOS automation-consent dialog after a gateway restart.
 */
export async function probeChromeMcpHealth(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
): Promise<ChromeBrowserAuthHealth> {
  const options = normalizeChromeMcpOptions(profileOptions);
  const cacheKey = buildChromeMcpSessionCacheKey(profileName, options);
  const session = sessions.get(cacheKey);
  if (session && session.transport.pid != null && sessionReadyState.get(session) === "ready") {
    return {
      level: "high",
      attached: true,
      mcpPid: session.transport.pid,
      port: null,
      browserUuid: null,
      reasons: ["cache:mcp-session-ready"],
      emptyState: false,
      cacheAttached: true,
    };
  }
  const verdict = await computeBrowserAuthConfidence({
    userDataDir: options.userDataDir,
    cdpUrl: options.browserUrl,
  });
  return { ...verdict, mcpPid: null, cacheAttached: false };
}

/**
 * Hard predicate: should an `ensureChromeMcpAvailable` spawn be permitted
 * given this health verdict? Encoded so blind-start is architecturally
 * impossible on the chrome-mcp / autoConnect / "user" profile path.
 *
 * Rules:
 *  - HIGH    → mayStart: false (already attached; just use it).
 *  - MEDIUM  → mayStart: false (visual verifier required to disambiguate;
 *              spawning here would re-fire the consent dialog).
 *  - LOW     → mayStart: true ONLY when `emptyState` (toggle off AND no
 *              port owner) is true. Any other LOW state means a Chrome
 *              process is running with remote-debugging on but in a state
 *              we can't safely attach to — re-spawning chrome-devtools-mcp
 *              would still pop the consent dialog, so we hold.
 */
export function decideStartGate(health: ChromeBrowserAuthHealth): StartGateDecision {
  if (health.level === "high") {
    return { mayStart: false, reason: "browser-already-attached", level: "high" };
  }
  if (health.level === "medium") {
    return {
      mayStart: false,
      reason: "browser-auth-visual-verification-required",
      level: "medium",
    };
  }
  if (health.emptyState) {
    return { mayStart: true, reason: "browser-not-running" };
  }
  return { mayStart: false, reason: "browser-auth-conflict", level: "low" };
}

export function formatStartGateBlockedMessage(
  profileName: string,
  health: ChromeBrowserAuthHealth,
  gate: Extract<StartGateDecision, { mayStart: false }>,
): string {
  const reasonsTail = health.reasons.length ? ` Signals: ${health.reasons.join(", ")}.` : "";
  if (gate.level === "high") {
    return (
      `Chrome MCP for profile "${profileName}" is already attached; refused to spawn a new ` +
      `chrome-devtools-mcp child that would re-trigger the browser remote-debugging consent dialog.${reasonsTail}`
    );
  }
  if (gate.level === "medium") {
    return (
      `Chrome MCP for profile "${profileName}": browser auth state is uncertain. Visual ` +
      `confirmation that no remote-debugging consent dialog or automation banner is showing is ` +
      `required before openclaw can attach. If Chrome is running, keep it open and approve any ` +
      `pending dialog; otherwise quit Chrome fully and retry.${reasonsTail}`
    );
  }
  return (
    `Chrome MCP for profile "${profileName}": browser auth signals conflict (e.g. remote ` +
    `debugging is enabled but no Chrome process owns the CDP port, or another process owns it). ` +
    `Spawning chrome-devtools-mcp would re-trigger the consent dialog. Quit Chrome fully or ` +
    `clear the conflicting listener, then retry.${reasonsTail}`
  );
}

export async function closeChromeMcpSession(profileName: string): Promise<boolean> {
  return await closeChromeMcpSessionsForProfile(profileName);
}

export async function stopAllChromeMcpSessions(): Promise<void> {
  const names = [...new Set([...sessions.keys()].map((key) => JSON.parse(key)[0] as string))];
  for (const name of names) {
    await closeChromeMcpSession(name).catch(() => {});
  }
}

export async function listChromeMcpPages(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpCallOptions = {},
): Promise<ChromeMcpStructuredPage[]> {
  const result = await callTool(profileName, profileOptions, "list_pages", {}, options);
  return extractStructuredPages(result);
}

export async function listChromeMcpTabs(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpCallOptions = {},
): Promise<BrowserTab[]> {
  return toBrowserTabs(await listChromeMcpPages(profileName, profileOptions, options));
}

export async function openChromeMcpTab(
  profileName: string,
  url: string,
  profileOptions?: string | ChromeMcpProfileOptions,
): Promise<BrowserTab> {
  const targetUrl = url.trim() || "about:blank";
  const result = await callTool(profileName, profileOptions, "new_page", {
    url: "about:blank",
    timeout: CHROME_MCP_NEW_PAGE_TIMEOUT_MS,
  });
  const pages = extractStructuredPages(result);
  const chosen = pages.find((page) => page.selected) ?? pages.at(-1);
  if (!chosen) {
    throw new Error("Chrome MCP did not return the created page.");
  }
  const targetId = String(chosen.id);
  const finalUrl =
    targetUrl === "about:blank"
      ? (chosen.url ?? targetUrl)
      : (
          await navigateChromeMcpPage({
            profileName,
            profile: typeof profileOptions === "string" ? undefined : profileOptions,
            userDataDir: typeof profileOptions === "string" ? profileOptions : undefined,
            targetId,
            url: targetUrl,
            timeoutMs: CHROME_MCP_NAVIGATE_TIMEOUT_MS,
          })
        ).url;
  return {
    targetId,
    title: "",
    url: finalUrl,
    type: "page",
  };
}

export async function focusChromeMcpTab(
  profileName: string,
  targetId: string,
  profileOptions?: string | ChromeMcpProfileOptions,
): Promise<void> {
  await callTool(profileName, profileOptions, "select_page", {
    pageId: parsePageId(targetId),
    bringToFront: true,
  });
}

export async function closeChromeMcpTab(
  profileName: string,
  targetId: string,
  profileOptions?: string | ChromeMcpProfileOptions,
): Promise<void> {
  await callTool(profileName, profileOptions, "close_page", { pageId: parsePageId(targetId) });
}

export async function navigateChromeMcpPage(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  url: string;
  timeoutMs?: number;
}): Promise<{ url: string }> {
  const resolvedTimeoutMs = params.timeoutMs ?? CHROME_MCP_NAVIGATE_TIMEOUT_MS;
  await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "navigate_page",
    {
      pageId: parsePageId(params.targetId),
      type: "url",
      url: params.url,
      timeout: resolvedTimeoutMs,
    },
    { timeoutMs: resolvedTimeoutMs + 5_000 },
  );
  const page = await findPageById(
    params.profileName,
    parsePageId(params.targetId),
    chromeMcpProfileOptionsFromParams(params),
  );
  return { url: page.url ?? params.url };
}

export async function takeChromeMcpSnapshot(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
}): Promise<ChromeMcpSnapshotNode> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "take_snapshot",
    {
      pageId: parsePageId(params.targetId),
    },
  );
  return extractSnapshot(result);
}

export async function takeChromeMcpScreenshot(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  uid?: string;
  fullPage?: boolean;
  format?: "png" | "jpeg";
  timeoutMs?: number;
}): Promise<Buffer> {
  return await withTempFile(async (filePath) => {
    await callTool(
      params.profileName,
      chromeMcpProfileOptionsFromParams(params),
      "take_screenshot",
      {
        pageId: parsePageId(params.targetId),
        filePath,
        format: params.format ?? "png",
        ...(params.uid ? { uid: params.uid } : {}),
        ...(params.fullPage ? { fullPage: true } : {}),
      },
      { timeoutMs: params.timeoutMs },
    );
    return await fs.readFile(filePath);
  });
}

export async function clickChromeMcpElement(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  uid: string;
  doubleClick?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "click",
    {
      pageId: parsePageId(params.targetId),
      uid: params.uid,
      ...(params.doubleClick ? { dblClick: true } : {}),
    },
    {
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    },
  );
}

export async function clickChromeMcpCoords(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  x: number;
  y: number;
  doubleClick?: boolean;
  button?: "left" | "right" | "middle";
  delayMs?: number;
}): Promise<void> {
  const button = params.button ?? "left";
  const buttonCode = button === "middle" ? 1 : button === "right" ? 2 : 0;
  const pressedButtons = button === "middle" ? 4 : button === "right" ? 2 : 1;
  const x = JSON.stringify(params.x);
  const y = JSON.stringify(params.y);
  const delayMs = JSON.stringify(Math.max(0, Math.floor(params.delayMs ?? 0)));
  const doubleClick = params.doubleClick ? "true" : "false";
  await evaluateChromeMcpScript({
    profileName: params.profileName,
    profile: params.profile,
    userDataDir: params.userDataDir,
    targetId: params.targetId,
    fn: `async () => {
      const x = ${x};
      const y = ${y};
      const delayMs = ${delayMs};
      const doubleClick = ${doubleClick};
      const target = document.elementFromPoint(x, y) ?? document.body ?? document.documentElement ?? document;
      const base = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: window.screenX + x,
        screenY: window.screenY + y,
        button: ${buttonCode},
      };
      const pressedButtons = ${pressedButtons};
      const dispatch = (type, buttons, detail) => {
        target.dispatchEvent(new MouseEvent(type, { ...base, buttons, detail }));
      };
      dispatch("mousemove", 0, 0);
      dispatch("mousedown", pressedButtons, 1);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      dispatch("mouseup", 0, 1);
      dispatch("click", 0, 1);
      if (doubleClick) {
        dispatch("mousedown", pressedButtons, 2);
        dispatch("mouseup", 0, 2);
        dispatch("click", 0, 2);
        dispatch("dblclick", 0, 2);
      }
      return true;
    }`,
  });
}

export async function fillChromeMcpElement(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  uid: string;
  value: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "fill", {
    pageId: parsePageId(params.targetId),
    uid: params.uid,
    value: params.value,
  });
}

export async function fillChromeMcpForm(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  elements: Array<{ uid: string; value: string }>;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "fill_form", {
    pageId: parsePageId(params.targetId),
    elements: params.elements,
  });
}

export async function hoverChromeMcpElement(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  uid: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "hover", {
    pageId: parsePageId(params.targetId),
    uid: params.uid,
  });
}

export async function dragChromeMcpElement(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  fromUid: string;
  toUid: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "drag", {
    pageId: parsePageId(params.targetId),
    from_uid: params.fromUid,
    to_uid: params.toUid,
  });
}

export async function uploadChromeMcpFile(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  uid: string;
  filePath: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "upload_file", {
    pageId: parsePageId(params.targetId),
    uid: params.uid,
    filePath: params.filePath,
  });
}

export async function pressChromeMcpKey(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  key: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "press_key", {
    pageId: parsePageId(params.targetId),
    key: params.key,
  });
}

export async function resizeChromeMcpPage(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  width: number;
  height: number;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "resize_page", {
    pageId: parsePageId(params.targetId),
    width: params.width,
    height: params.height,
  });
}

export async function handleChromeMcpDialog(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  action: "accept" | "dismiss";
  promptText?: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "handle_dialog", {
    pageId: parsePageId(params.targetId),
    action: params.action,
    ...(params.promptText ? { promptText: params.promptText } : {}),
  });
}

export async function evaluateChromeMcpScript(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  fn: string;
  args?: string[];
}): Promise<unknown> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "evaluate_script",
    {
      pageId: parsePageId(params.targetId),
      function: params.fn,
      ...(params.args?.length ? { args: params.args } : {}),
    },
  );
  return extractJsonMessage(result);
}

export async function waitForChromeMcpText(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  text: string[];
  timeoutMs?: number;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "wait_for", {
    pageId: parsePageId(params.targetId),
    text: params.text,
    ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
  });
}

export function setChromeMcpSessionFactoryForTest(factory: ChromeMcpSessionFactory | null): void {
  sessionFactory = factory;
}

export async function resetChromeMcpSessionsForTest(): Promise<void> {
  sessionFactory = null;
  // Disable the file-based remote-debugging prober by default in tests so that
  // probeChromeMcpHealth's cache-only behavior is preserved unless a test
  // opts in via setChromeRemoteDebuggingProberForTest.
  chromeRemoteDebuggingProber = CHROME_REMOTE_DEBUGGING_PROBER_DISABLED;
  signalProbes = {
    fileProbe: (input) => chromeRemoteDebuggingProber(input),
    portOwnerProbe: async () => ({ kind: "unknown", reason: "test-disabled" }),
    jsonVersionProbe: async () => ({ ok: false, reason: "test-disabled" }),
  };
  browserAuthVisualVerifier = null;
  pendingSessions.clear();
  await stopAllChromeMcpSessions();
}
