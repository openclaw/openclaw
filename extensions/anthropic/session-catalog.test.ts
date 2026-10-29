import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
} from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { SessionCatalogProvider as RegisteredSessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listClaudeSessions } from "./session-catalog-discovery.js";
import { listClaudeSessionCatalog } from "./session-catalog-listing.js";
import {
  createClaudeSessionNodeInvokePolicies,
  registerClaudeSessionDiscovery,
} from "./session-catalog-registration.js";
import { createClaudeCatalogWatchDriver } from "./session-catalog-watch.test-support.js";
import {
  CLAUDE_CLI_NODE_RUN_COMMAND,
  CLAUDE_SESSIONS_LIST_COMMAND,
  CLAUDE_SESSION_READ_COMMAND,
  CLAUDE_TERMINAL_RESUME_COMMAND,
  CLAUDE_TERMINAL_START_COMMAND,
  listLocalClaudeSessionPage as listPage,
  readLocalClaudeTranscriptPage as readPage,
} from "./session-catalog.js";

type SessionCatalogProvider = RegisteredSessionCatalogProvider;

function bindTestCatalogOwner(provider: RegisteredSessionCatalogProvider): SessionCatalogProvider {
  return {
    ...provider,
    list: (params) => provider.list({ agentId: "main", ...params }),
    read: (params) => provider.read({ agentId: "main", ...params }),
    continueSession: (params) => provider.continueSession!({ agentId: "main", ...params }),
    openTerminal: (params) => provider.openTerminal!({ agentId: "main", ...params }),
  } as SessionCatalogProvider;
}

function registerClaudeSessionCatalog(api: OpenClawPluginApi): void {
  registerClaudeSessionDiscovery({
    ...api,
    registerNodeHostCommand: api.registerNodeHostCommand ?? (() => {}),
  });
}

function createClaudeSessionNodeHostCommands(): OpenClawPluginNodeHostCommand[] {
  const commands: OpenClawPluginNodeHostCommand[] = [];
  registerClaudeSessionDiscovery({
    id: "anthropic",
    config: {},
    runtime: createPluginRuntimeMock(),
    registerSessionCatalog: () => {},
    registerNodeHostCommand: (command: OpenClawPluginNodeHostCommand) => {
      commands.push(command);
    },
  } as unknown as OpenClawPluginApi);
  return commands;
}

function terminalCommand(name: string) {
  const command = createClaudeSessionNodeHostCommands().find((entry) => entry.command === name);
  if (!command || command.duplex !== true) {
    throw new Error(`Expected duplex command: ${name}`);
  }
  return command;
}

function captureCatalogProvider(runtime: PluginRuntime): SessionCatalogProvider {
  let provider: SessionCatalogProvider | undefined;
  const runtimeWithSession = {
    ...runtime,
    config: runtime.config ?? { current: () => ({}) },
    agent: runtime.agent ?? { session: { listSessionEntries: () => [] } },
  } as PluginRuntime;
  registerClaudeSessionCatalog({
    id: "anthropic",
    config: {},
    runtime: runtimeWithSession,
    registerSessionCatalog: (candidate: RegisteredSessionCatalogProvider) => {
      provider = bindTestCatalogOwner(candidate);
    },
  } as unknown as OpenClawPluginApi);
  if (!provider) {
    throw new Error("expected Anthropic session catalog registration");
  }
  return provider;
}

const homes: string[] = [];
const originalHome = process.env.HOME;
const originalPath = process.env.PATH;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const nodeHostMocks = await vi.hoisted(async () => {
  const { createNodeHostMocks } = await import("../test-support/node-host.test-support.js");
  return createNodeHostMocks({ userShellFallback: true });
});

// mock-isolation: Shared owner preserves real exports with fresh command-resolution mocks.
vi.mock("openclaw/plugin-sdk/node-host", nodeHostMocks.mockRuntime);

function projectFile(home: string, ...parts: string[]): string {
  return path.join(home, ".claude", "projects", "-workspace", ...parts);
}

async function writeClaudeExecutable(directory: string, source = "#!/bin/sh\n"): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const executable = path.join(directory, process.platform === "win32" ? "claude.cmd" : "claude");
  await fs.writeFile(executable, process.platform === "win32" ? "@echo off\r\n" : source);
  if (process.platform !== "win32") {
    await fs.chmod(executable, 0o755);
  }
  return executable;
}

async function createHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-catalog-"));
  homes.push(home);
  return home;
}

async function expectClaudeCatalogEventually(
  home: string,
  assertion: (page: Awaited<ReturnType<typeof listPage>>) => void | Promise<void>,
  options: Parameters<typeof listPage>[0] = {},
) {
  return vi.waitFor(
    async () => {
      const page = await listPage(options, home);
      await assertion(page);
      return page;
    },
    { timeout: 2_000, interval: 25 },
  );
}

/** Polls until the provider's watches vouch for coverage and an unchanged tree costs no home I/O. */
async function expectClaudeCatalogQuiescent<Spy extends { mockClear: () => void }>(
  home: string,
  spies: readonly Spy[],
  homeCalls: (spy: Spy) => unknown[],
  expected: Awaited<ReturnType<typeof listPage>>,
) {
  await vi.waitFor(
    async () => {
      for (const spy of spies) {
        spy.mockClear();
      }
      expect(await listPage({}, home)).toEqual(expected);
      for (const spy of spies) {
        expect(homeCalls(spy)).toEqual([]);
      }
    },
    { timeout: 3_000, interval: 25 },
  );
}

async function writeProject(params: {
  home: string;
  project?: string;
  entries?: Array<Record<string, unknown>>;
  transcripts: Record<string, Array<Record<string, unknown>>>;
}): Promise<void> {
  const projectDir = path.join(params.home, ".claude", "projects", params.project ?? "-workspace");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({ version: 1, entries: params.entries ?? [] }),
  );
  await Promise.all(
    Object.entries(params.transcripts).map(([sessionId, rows]) =>
      fs.writeFile(
        path.join(projectDir, `${sessionId}.jsonl`),
        `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      ),
    ),
  );
}

function indexedEntry(home: string, sessionId: string, extra: Record<string, unknown> = {}) {
  return { sessionId, fullPath: projectFile(home, `${sessionId}.jsonl`), ...extra };
}

function writeTranscript(
  home: string,
  sessionId: string,
  rows: Record<string, unknown>[],
  entry: Record<string, unknown> = {},
) {
  return writeProject({
    home,
    entries: [indexedEntry(home, sessionId, entry)],
    transcripts: { [sessionId]: rows },
  });
}

function routedConfig(model = "claude-opus-4-8"): OpenClawConfig {
  return {
    agents: {
      defaults: { models: { [`anthropic/${model}`]: { agentRuntime: { id: "claude-cli" } } } },
    },
  };
}

function nodeRuntime(
  nodes: Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"],
  invoke: PluginRuntime["nodes"]["invoke"],
): PluginRuntime {
  return { nodes: { list: vi.fn(async () => ({ nodes })), invoke } } as unknown as PluginRuntime;
}

const nodeSession = (threadId: string, extra: Record<string, unknown> = {}) => ({
  threadId,
  status: "stored",
  source: "claude-cli",
  modelProvider: "anthropic",
  archived: false,
  ...extra,
});

const nodePayload = (payload: unknown) => ({ payloadJSON: JSON.stringify(payload) });

const terminalIo = () => ({
  signal: new AbortController().signal,
  emitChunk: vi.fn(),
  onInput: vi.fn(),
});

function writeIndexedSession(
  home: string,
  sessionId: string,
  entry: Record<string, unknown>,
  text = "hello",
) {
  return writeTranscript(home, sessionId, [message(sessionId, "user", text, 1)], entry);
}

async function writeDesktopMetadata(
  home: string,
  name: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(
    home,
    "Library/Application Support/Claude/claude-code-sessions/account/workspace",
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `local_${name}.json`), JSON.stringify(metadata));
}

async function writeIndexedDesktopSession(
  home: string,
  sessionId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await writeIndexedSession(home, sessionId, { projectPath: "/work/openclaw", isSidechain: false });
  await writeDesktopMetadata(home, "fixture", {
    sessionId: DESKTOP_SESSION_ID,
    cliSessionId: sessionId,
    cwd: "/work/openclaw",
    title: "Desktop session",
    ...metadata,
  });
}

const DESKTOP_SESSION_ID = "local_11111111-1111-1111-1111-111111111111";

// Fixed SSTables from the synthetic Desktop store. The first three use Snappy
// literal/copy records; the others exercise invalid labels and last-sequence wins.
const DESKTOP_TABLES = {
  Release:
    "0gHwoAAongFfaHR0cHM6Ly9jbGF1ZGUuYWkAAWRmcmFtZS1zdG9yZQEBAAAAAAAAeyJpZCI6ImNnLTIyMjIyMjIyLTIyMjItMjIyMi0yMjIyLTIyMjIyMjIyMjIyMiIsIm5hbWUiOiJSZWxlYXNlIn17ImNvZGU6bG9jYWxfMTExMTExMTEtMTExMS0xMTExLTExMTEtMTExMTExMTExMTExIjoimm4AJCJ9AAAAAAEAAAABAAAAAAABA3gAswEAAAAAAQAAAAAAAAAAAAC4AQ8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  Changed:
    "0gHwoAAongFfaHR0cHM6Ly9jbGF1ZGUuYWkAAWRmcmFtZS1zdG9yZQEBAAAAAAAAeyJpZCI6ImNnLTIyMjIyMjIyLTIyMjItMjIyMi0yMjIyLTIyMjIyMjIyMjIyMiIsIm5hbWUiOiJDaGFuZ2VkIn17ImNvZGU6bG9jYWxfMTExMTExMTEtMTExMS0xMTExLTExMTEtMTExMTExMTExMTExIjoimm4AJCJ9AAAAAAEAAAABAAAAAAABA3gAswEAAAAAAQAAAAAAAAAAAAC4AQ8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "Normal poll update":
    "3QHwqwAoqQFfaHR0cHM6Ly9jbGF1ZGUuYWkAAWRmcmFtZS1zdG9yZQEBAAAAAAAAeyJpZCI6ImNnLTIyMjIyMjIyLTIyMjItMjIyMi0yMjIyLTIyMjIyMjIyMjIyMiIsIm5hbWUiOiJOb3JtYWwgcG9sbCB1cGRhdGUifXsiY29kZTpsb2NhbF8xMTExMTExMS0xMTExLTExMTEtMTExMS0xMTExMTExMTExMTEiOiKaeQAkIn0AAAAAAQAAAAEAAAAAAAEDeAC+AQAAAAABAAAAAAAAAAAAAMMBDwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  "decoder garbage":
    "ACjiAV9odHRwczovL2NsYXVkZS5haQABZGZyYW1lLXN0b3JlAQEAAAAAAAB7ImlkIjoiY2ctMjIyMjIyMjItMjIyMi0yMjIyLTIyMjItMjIyMjIyMjIyMjIyIiwibmFtZSI6IlJlbGUSKQxhc2UifXsiaWQiOiJjZy0yMjIyMjIyMi0yMjIyLTIyMjItMjIyMi0yMjIyMjIyMjIyMjIiLCJuYW1lIjoiUmVsZWFzZSJ9eyJjb2RlOmxvY2FsXzExMTExMTExLTExMTEtMTExMS0xMTExLTExMTExMTExMTExMSI6ImNnLTIyMjIyMjIyLTIyMjItMjIyMi0yMjIyLTIyMjIyMjIyMjIyMiJ9AAAAAAEAAAAAAAAAAAABA3gAlgIAAAAAAQAAAAAAAAAAAACbAg8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "newer empty entry":
    "ACieAV9odHRwczovL2NsYXVkZS5haQABZGZyYW1lLXN0b3JlAQEAAAAAAAB7ImlkIjoiY2ctMjIyMjIyMjItMjIyMi0yMjIyLTIyMjItMjIyMjIyMjIyMjIyIiwibmFtZSI6IlJlbGVhc2UifXsiY29kZTpsb2NhbF8xMTExMTExMS0xMTExLTExMTEtMTExMS0xMTExMTExMTExMTEiOiJjZy0yMjIyMjIyMi0yMjIyLTIyMjItMjIyMi0yMjIyMjIyMjIyMjIifSEHAgIAAAAAAAB7fQAAAAABAAAAAAAAAAAAAQN4AN4BAAAAAAEAAAAAAAAAAAAA4wEPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
};

async function writeDesktopGroupStore(home: string, fixture: keyof typeof DESKTOP_TABLES) {
  const dir = path.join(home, "Library/Application Support/Claude/Local Storage/leveldb");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "000001.ldb"), Buffer.from(DESKTOP_TABLES[fixture], "base64"));
}

async function writeBrokenClaudeNpmShim(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true });
  const executable = path.join(binDir, process.platform === "win32" ? "claude.cmd" : "claude");
  const packageExecutable = path.join(
    binDir,
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe",
  );
  await fs.mkdir(path.dirname(packageExecutable), { recursive: true });
  await fs.writeFile(
    packageExecutable,
    [
      'echo "Error: claude native binary not installed." >&2',
      'echo "node node_modules/@anthropic-ai/claude-code/install.cjs" >&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    executable,
    process.platform === "win32"
      ? '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n'
      : '#!/bin/sh\nexec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"\n',
  );
  if (process.platform !== "win32") {
    await fs.chmod(executable, 0o755);
    await fs.chmod(packageExecutable, 0o755);
  }
  return executable;
}

function message(
  sessionId: string,
  type: "user" | "assistant",
  text: string | Record<string, unknown>[],
  index: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type,
    sessionId,
    uuid: `${sessionId}-${index}`,
    timestamp: `2026-07-0${index}T00:00:00.000Z`,
    isSidechain: false,
    message: {
      role: type,
      content: typeof text === "string" ? [{ type: "text", text }] : text,
      ...(type === "assistant" ? { model: "claude-opus-4-8" } : {}),
    },
    ...extra,
  };
}

function sdkCliMessage(sessionId: string, text: string): Record<string, unknown> {
  return message(sessionId, "user", text, 1, {
    entrypoint: "sdk-cli",
    cwd: `/work/${sessionId}`,
    version: "2.1.204",
  });
}

async function writeBudgetSessions(home: string) {
  const directory = projectFile(home);
  await fs.mkdir(directory, { recursive: true });
  const transcript = Buffer.alloc(1024 * 1024, `${"x".repeat(16 * 1024 - 1)}\n`);
  for (let index = 0; index < 66; index += 1) {
    const id = `budget-${String(index).padStart(2, "0")}`;
    const line = `\n${JSON.stringify(sdkCliMessage(id, id))}\n`;
    transcript.write(line, transcript.length - Buffer.byteLength(line));
    await fs.writeFile(projectFile(home, `${id}.jsonl`), transcript);
  }
  return (await fs.readdir(directory))
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length));
}

async function writeUnindexedCliSessions(
  home: string,
  sessions: Record<string, string>,
  project?: string,
): Promise<void> {
  await writeProject({
    home,
    project,
    transcripts: Object.fromEntries(
      Object.entries(sessions).map(([sessionId, text]) => [
        sessionId,
        [sdkCliMessage(sessionId, text)],
      ]),
    ),
  });
}

async function writeLongPagedTranscript(params: {
  home: string;
  sessionId: string;
  truncated?: boolean;
}): Promise<string> {
  const oldUser = "old user ".repeat(20_000);
  await writeTranscript(
    params.home,
    params.sessionId,
    params.truncated
      ? [
          message(params.sessionId, "user", oldUser, 1),
          message(params.sessionId, "assistant", "new assistant", 2),
        ]
      : [
          { type: "queue-operation", sessionId: params.sessionId },
          message(params.sessionId, "user", oldUser, 1),
          message(params.sessionId, "assistant", "old assistant", 2),
          message(params.sessionId, "user", "new user", 3),
          message(params.sessionId, "assistant", "new assistant", 4),
        ],
    { summary: "Transcript", modified: "2026-07-04T00:00:00.000Z", isSidechain: false },
  );
  return oldUser;
}

// Cap positional reads on one transcript; a zero cap simulates mid-window EOF.
function injectTranscriptShortReads(
  sessionId: string,
  plan: (input: {
    length: number;
    position: number;
    call: number;
    firstPosition: number;
  }) => number,
): void {
  const realOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    const [target] = args;
    if (typeof target === "string" && target.endsWith(`${sessionId}.jsonl`)) {
      const realRead = handle.read.bind(handle) as (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => Promise<{ bytesRead: number; buffer: Buffer }>;
      let call = 0;
      let firstPosition = -1;
      Object.defineProperty(handle, "read", {
        configurable: true,
        value: (buffer: Buffer, offset: number, length: number, position: number) => {
          if (firstPosition < 0) {
            firstPosition = position;
          }
          const allowed = plan({ length, position, call, firstPosition });
          call += 1;
          return realRead(buffer, offset, allowed, position);
        },
      });
    }
    return handle;
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  nodeHostMocks.runNodePtyCommand.mockClear();
  nodeHostMocks.userShellPaths.clear();
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("Claude session catalog", () => {
  it("reports the discovery frontier and finds and reads an exact ID beyond it", async () => {
    const home = await createHome();
    const watches = createClaudeCatalogWatchDriver(home);
    const targetId = (await writeBudgetSessions(home)).at(-1)!;
    const local = { includeDesktop: false };
    const page = (query: Parameters<typeof listPage>[0]) => listPage(query, home, local);
    const first = await page({ limit: 50 });
    watches.arm();
    expect([first.nextCursor, first.error]).toEqual([expect.any(String), undefined]);
    const last = await page({ cursor: first.nextCursor });
    expect([...first.sessions, ...last.sessions].map((session) => session.threadId)).not.toContain(
      targetId,
    );
    expect([last.nextCursor, last.error?.code]).toEqual([undefined, "DISCOVERY_TRUNCATED"]);

    const open = vi.spyOn(fs, "open");
    expect((await readPage({ threadId: targetId, limit: 1 }, home, local)).items).toMatchObject([
      { text: targetId },
    ]);
    expect(open.mock.calls.map(([file]) => file)).toEqual(
      Array<string>(2).fill(projectFile(home, `${targetId}.jsonl`)),
    );
    expect(
      (await page({ searchTerm: targetId.toUpperCase() })).sessions.map(
        (session) => session.threadId,
      ),
    ).toEqual([targetId]);
    expect(await page({ searchTerm: "missing-session" })).toMatchObject({
      sessions: [],
      error: { code: "DISCOVERY_TRUNCATED" },
    });
    expect(await page({ cursor: first.nextCursor })).toEqual(last);

    const runtime = nodeRuntime(
      [{ nodeId: "paired", connected: true, commands: [CLAUDE_SESSIONS_LIST_COMMAND] }],
      vi.fn(async ({ params }: Parameters<PluginRuntime["nodes"]["invoke"]>[0]) =>
        nodePayload(await page(params)),
      ),
    );
    const remote = await listClaudeSessionCatalog({
      runtime,
      query: { hostIds: ["node:paired"], cursors: { "node:paired": first.nextCursor } },
    });
    expect([remote.hosts[0]?.error?.code, remote.hosts[0]?.sessions]).toEqual([
      "DISCOVERY_TRUNCATED",
      last.sessions,
    ]);
  });

  it("does not start paired hosts when retired during node inventory", async () => {
    const inventory = createDeferred<Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>>();
    const inventoryStarted = createDeferred<void>();
    const listNodes = vi.fn(() => {
      inventoryStarted.resolve();
      return inventory.promise;
    });
    const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(async () => ({
      payloadJSON: JSON.stringify({ sessions: [] }),
    }));
    const provider = captureCatalogProvider({
      nodes: { list: listNodes, invoke },
    } as unknown as PluginRuntime);
    const controller = new AbortController();
    const reason = new Error("catalog retired during inventory");
    const listed = provider
      .list({
        hostIds: ["node:late"],
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    await inventoryStarted.promise;
    controller.abort(reason);
    inventory.resolve({
      nodes: [{ nodeId: "late", connected: true, commands: [CLAUDE_SESSIONS_LIST_COMMAND] }],
    });
    const result = await listed;
    expect(invoke).not.toHaveBeenCalled();
    expect(result).toBe(reason);
  });

  it("lists an explicit CLAUDE_CONFIG_DIR while isolated", async () => {
    const home = await createHome();
    const configParent = await createHome();
    const sessionId = "explicit-config-root";
    await writeProject({
      home: configParent,
      entries: [{ sessionId, summary: "Explicit config session", isSidechain: false }],
      transcripts: { [sessionId]: [message(sessionId, "user", "explicit root", 1)] },
    });
    await writeDesktopMetadata(home, "private", {
      cliSessionId: sessionId,
      sessionId: "desktop-private",
      title: "Private desktop title",
    });
    process.env.HOME = home;
    process.env.CLAUDE_CONFIG_DIR = path.join(configParent, ".claude");
    const provider = captureCatalogProvider({
      nodes: { list: vi.fn().mockResolvedValue({ nodes: [] }) },
    } as unknown as PluginRuntime);

    await expect(
      provider.list({ allowProcessHomeFallback: false, hostIds: ["gateway:local"] }),
    ).resolves.toMatchObject([
      {
        hostId: "gateway:local",
        sessions: [
          {
            threadId: sessionId,
            name: "Explicit config session",
            source: "claude-cli",
          },
        ],
      },
    ]);
  });

  it.each([false, true])(
    "adopts a CLI row with a locked fork binding (remote=%s)",
    async (remote) => {
      const threadId = "source-session";
      const home = await createHome();
      process.env.HOME = home;
      const cwd = "/work/source";
      const name = "Renamed source";
      const color = "purple";
      const createSessionEntry = vi.fn(async (params: Record<string, unknown>) => ({
        key: String(params.key),
        agentId: "main",
        sessionId: "adopted",
        entry: { sessionId: "adopted", updatedAt: 1 },
      }));
      const commands = [
        CLAUDE_SESSIONS_LIST_COMMAND,
        CLAUDE_SESSION_READ_COMMAND,
        CLAUDE_CLI_NODE_RUN_COMMAND,
        CLAUDE_TERMINAL_RESUME_COMMAND,
      ];
      const nodes = [
        { nodeId: "node-a", connected: true, commands, invocableCommands: [...commands] },
      ];
      const invoke = vi.fn(async ({ command }: Parameters<PluginRuntime["nodes"]["invoke"]>[0]) =>
        nodePayload(
          command === CLAUDE_SESSIONS_LIST_COMMAND
            ? {
                sessions: [
                  nodeSession(threadId, {
                    name,
                    color,
                    cwd,
                    pullRequest: { numbers: [1234], state: "open" },
                  }),
                ],
              }
            : { threadId, items: [{ type: "userMessage", text: "history", uuid: "history-1" }] },
        ),
      );
      const session = { listSessionEntries: () => [], createSessionEntry };
      const provider = captureCatalogProvider(
        remote
          ? ({
              ...nodeRuntime(nodes, invoke),
              config: { current: () => routedConfig() },
              agent: { session },
            } as unknown as PluginRuntime)
          : createPluginRuntimeMock({
              config: { current: () => routedConfig() },
              agent: { session },
            }),
      );
      if (!remote) {
        await writeTranscript(
          home,
          threadId,
          [
            message(threadId, "user", "source prompt", 1),
            { type: "custom-title", customTitle: name, sessionId: threadId },
            { type: "agent-color", agentColor: color, sessionId: threadId },
          ],
          { summary: "Stale title", projectPath: cwd },
        );
      }
      const hostId = remote ? "node:node-a" : "gateway:local";
      const request = { hostId, threadId };
      if (remote) {
        expect((await provider.list({ hostIds: [hostId] }))[0]?.sessions).toMatchObject([
          {
            threadId,
            color,
            pullRequest: { numbers: [1234], state: "open" },
            canContinue: true,
            canOpenTerminal: true,
          },
        ]);
        await expect(provider.openTerminal?.(request)).resolves.toMatchObject({
          kind: "node",
          nodeId: "node-a",
          command: CLAUDE_TERMINAL_RESUME_COMMAND,
          uploadPathStyle: "native",
          cwd,
        });
      }
      await expect(provider.continueSession?.(request)).resolves.toMatchObject({
        sessionKey: expect.stringContaining("plugin:anthropic:catalog-adopt:claude:"),
        upstream: {
          kind: "claude-cli",
          ref: remote
            ? { nodeId: "node-a", threadId }
            : { filePath: expect.stringContaining(threadId + ".jsonl") },
          marker: remote ? { uuid: "history-1" } : { offset: expect.any(Number) },
        },
      });
      // Names are display metadata, not unique labels; the first resume must fork.
      expect(createSessionEntry.mock.calls[0]?.[0]).toMatchObject({
        displayName: name,
        spawnedCwd: cwd,
        ...(remote ? { execNode: "node-a", execCwd: cwd } : {}),
        initialEntry: {
          color,
          cliBackendId: "claude-cli",
          model: "claude-opus-4-8",
          modelSelectionLocked: true,
          pluginOwnerId: "anthropic",
          cliSessionBinding: { sessionId: threadId, forceReuse: true, forkNextResume: true },
          ...(remote
            ? {
                pluginExtensions: {
                  anthropic: {
                    sessionCatalog: {
                      sourceHostId: hostId,
                      sourceThreadId: threadId,
                    },
                  },
                },
              }
            : {}),
        },
      });
      expect(createSessionEntry.mock.calls[0]?.[0]).not.toHaveProperty("label");
      if (remote) {
        expect(invoke.mock.calls.every(([call]) => call.scopes?.includes("operator.write"))).toBe(
          true,
        );
        nodes[0]!.invocableCommands = commands.filter(
          (command) => command !== CLAUDE_TERMINAL_RESUME_COMMAND,
        );
        expect((await provider.list({ hostIds: [hostId] }))[0]?.sessions).toMatchObject([
          { threadId, canOpenTerminal: false },
        ]);
        await expect(provider.openTerminal?.(request)).rejects.toThrow(
          "paired-node Claude terminal is unavailable",
        );
      }
    },
  );

  it("refreshes creation availability when a non-default Claude CLI route changes", () => {
    let config: OpenClawConfig = {};
    const provider = captureCatalogProvider(
      createPluginRuntimeMock({ config: { current: () => config } }),
    );
    expect(provider.resolveCreateSession?.({})).toBeUndefined();

    config = routedConfig("claude-sonnet-4-6");
    expect(provider.resolveCreateSession?.({})).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      agentRuntime: "claude-cli",
    });

    config = {};
    expect(provider.resolveCreateSession?.({})).toBeUndefined();
  });

  it.each([
    {
      policy: "runtime",
      research: {
        models: { "anthropic/claude-opus-4-8": { agentRuntime: { id: "openclaw" } } },
      },
    },
    {
      policy: "model allowlist",
      research: { modelPolicy: { allow: ["anthropic/claude-sonnet-4-6"] } },
    },
  ])("resolves creation against the requested agent's $policy", ({ research }) => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-8" },
          models: { "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } } },
        },
        entries: {
          main: {},
          research: { ...research },
        },
      },
    } satisfies OpenClawConfig;
    const provider = captureCatalogProvider(
      createPluginRuntimeMock({ config: { current: () => config } }),
    );

    expect(provider.resolveCreateSession?.({ agentId: "main" })).toEqual({
      model: "anthropic/claude-opus-4-8",
      agentRuntime: "claude-cli",
    });
    expect(provider.resolveCreateSession?.({ agentId: "research" })).toBeUndefined();
  });

  async function listCatalogWithBoundSession(
    entry: (sessionId: string) => Record<string, unknown>,
    sessionId = "claude-bound-session",
  ) {
    const home = await createHome();
    process.env.HOME = home;
    await writeIndexedSession(
      home,
      sessionId,
      { summary: "Bound session", projectPath: "/work/source" },
      "source prompt",
    );
    const provider = captureCatalogProvider({
      config: { current: () => ({}) },
      agent: {
        session: {
          listSessionEntries: () => [
            { sessionKey: "agent:main:claude-bound", entry: entry(sessionId) },
          ],
        },
      },
    } as unknown as PluginRuntime);
    return await provider?.list({});
  }

  // An OpenClaw session that merely routes its turns through the Claude CLI keeps
  // its own sidebar row, in whatever group the operator filed it under. Listing
  // its thread here would hide that row inside the Claude catalog instead.
  it.each([true, false])(
    "lists bound CLI sessions only when adopted (adopted=%s)",
    async (adopted) => {
      const hosts = await listCatalogWithBoundSession((sessionId) =>
        adopted
          ? {
              cliSessionBindings: { "claude-cli": { sessionId: "" } },
              pluginOwnerId: "anthropic",
              modelSelectionLocked: true,
              pluginExtensions: { anthropic: { sessionCatalog: { sourceThreadId: sessionId } } },
            }
          : {
              cliSessionBindings: { "claude-cli": { sessionId } },
              category: "Home Assistant",
            },
      );
      if (adopted) {
        expect(hosts?.[0]?.sessions[0]?.sessionKey).toBe("agent:main:claude-bound");
      } else {
        expect(hosts?.[0]?.sessions).toEqual([]);
      }
    },
  );

  it("keeps policy-blocked, non-advertising, and Desktop rows view-only", async () => {
    const threadId = "view-only-session";
    const commands = [CLAUDE_SESSIONS_LIST_COMMAND, CLAUDE_SESSION_READ_COMMAND];
    const nodes = [
      {
        nodeId: "node-view",
        connected: true,
        commands,
        invocableCommands: [] as string[],
      },
    ];
    const provider = captureCatalogProvider(
      nodeRuntime(
        nodes,
        vi.fn(async () =>
          nodePayload({ sessions: [nodeSession(threadId, { source: "claude-desktop" })] }),
        ),
      ),
    );

    for (const [advertised, invocable] of [
      [commands, []],
      [[...commands, CLAUDE_CLI_NODE_RUN_COMMAND], []],
      [
        [...commands, CLAUDE_CLI_NODE_RUN_COMMAND],
        [CLAUDE_SESSIONS_LIST_COMMAND, CLAUDE_CLI_NODE_RUN_COMMAND],
      ],
    ] satisfies Array<[string[], string[]]>) {
      nodes[0]!.commands = advertised;
      nodes[0]!.invocableCommands = invocable;
      expect(
        (await provider.list({ hostIds: ["node:node-view"] }))[0]?.sessions[0]?.canContinue,
      ).toBe(false);
      await expect(
        provider.continueSession?.({ hostId: "node:node-view", threadId }),
      ).rejects.toThrow("does not permit Claude CLI session continuation");
    }

    nodes[0]!.invocableCommands = [
      CLAUDE_SESSIONS_LIST_COMMAND,
      CLAUDE_SESSION_READ_COMMAND,
      CLAUDE_CLI_NODE_RUN_COMMAND,
    ];
    await expect(
      provider?.continueSession?.({ hostId: "node:node-view", threadId }),
    ).rejects.toThrow("only Claude CLI sessions can be continued");
  });

  it("merges CLI indexes with active Desktop metadata and hides archived Desktop sessions", async () => {
    const home = await createHome();
    await writeProject({
      home,
      entries: (
        [
          ["cli-session", "CLI title", "01", "/work/cli"],
          ["desktop-session", "Index title", "02", "/work/desktop"],
          ["archived-session", "Archived", "03"],
        ] satisfies Array<[string, string, string, string?]>
      ).map(([id, summary, day, projectPath]) =>
        indexedEntry(home, id, {
          summary,
          modified: `2026-07-${day}T00:00:00.000Z`,
          isSidechain: false,
          ...(projectPath ? { projectPath } : {}),
        }),
      ),
      transcripts: Object.fromEntries(
        ["CLI", "Desktop", "Archived"].map((text) => {
          const id = `${text.toLowerCase()}-session`;
          return [id, [message(id, "user", text, 1)]];
        }),
      ),
    });
    await writeDesktopMetadata(home, "active", {
      sessionId: "local-active",
      cliSessionId: "desktop-session",
      title: "Desktop title",
      cwd: "/desktop/cwd",
      lastActivityAt: Date.parse("2026-07-04T00:00:00.000Z"),
      isArchived: false,
    });
    await writeDesktopMetadata(home, "archived", {
      sessionId: "local-archived",
      cliSessionId: "archived-session",
      title: "Archived title",
      isArchived: true,
    });

    const first = await listPage({ limit: 1 }, home);
    expect(first.sessions).toMatchObject([
      {
        threadId: "desktop-session",
        name: "Desktop title",
        cwd: "/desktop/cwd",
        source: "claude-desktop",
        archived: false,
      },
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(listPage({ limit: 1, cursor: ` ${first.nextCursor} ` }, home)).rejects.toThrow(
      "catalog cursor is invalid",
    );
    const runtime = { nodes: { list: vi.fn() } } as unknown as PluginRuntime;
    const provider = captureCatalogProvider(runtime);
    await expect(
      provider.list({
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": ` ${first.nextCursor} ` },
      }),
    ).rejects.toThrow("cursor for gateway:local is invalid");

    const second = await listPage({ limit: 1, cursor: first.nextCursor }, home);
    expect(second.sessions).toMatchObject([
      {
        threadId: "cli-session",
        name: "CLI title",
        source: "claude-cli",
      },
    ]);
    expect(second.nextCursor).toBeUndefined();
    await expect(readPage({ threadId: "archived-session", limit: 1 }, home)).rejects.toThrow(
      "Claude session is unavailable",
    );
    await expect(listPage({ cursor: "x".repeat(257) }, home)).rejects.toThrow(
      "catalog cursor is invalid",
    );
    await expect(listPage({ cursor: null }, home)).rejects.toThrow("catalog cursor is invalid");
  });

  it("imports a Claude Desktop custom group for its matching catalog row", async () => {
    const home = await createHome();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const sessionId = "desktop-custom-group";
    await writeIndexedDesktopSession(home, sessionId);
    await writeDesktopGroupStore(home, "Release");

    const groupFile = path.join(
      home,
      "Library/Application Support/Claude/Local Storage/leveldb/000001.ldb",
    );
    const fixedGroupTime = new Date("2026-07-20T12:00:00.000Z");
    await fs.utimes(groupFile, fixedGroupTime, fixedGroupTime);
    await expect(listPage({}, home)).resolves.toMatchObject({
      sessions: [{ threadId: sessionId, customGroup: "Release", source: "claude-desktop" }],
    });
    const readFile = vi.spyOn(fs, "readFile");
    now += 60_001;
    await expectClaudeCatalogEventually(home, (page) =>
      expect(page.sessions[0]?.customGroup).toBe("Release"),
    );
    expect(readFile.mock.calls.filter(([target]) => target === groupFile)).toEqual([]);
    await writeDesktopGroupStore(home, "Changed");
    await fs.utimes(groupFile, fixedGroupTime, fixedGroupTime);
    expect((await listClaudeSessions(home, { forceRefresh: true })).records[0]?.customGroup).toBe(
      "Changed",
    );
    const armingSpies = (["lstat", "readdir"] as const).map((method) => vi.spyOn(fs, method));
    await expectClaudeCatalogQuiescent(
      home,
      armingSpies,
      (spy) =>
        spy.mock.calls.filter(([target]) => typeof target === "string" && target.startsWith(home)),
      await listPage({}, home),
    );
    await writeDesktopGroupStore(home, "Normal poll update");
    now += 60_001;
    expect((await listPage({}, home)).sessions[0]?.customGroup).toBe("Normal poll update");
  });

  it("retains the current Claude Desktop pull request when history is truncated", async () => {
    const home = await createHome();
    const sessionId = "desktop-pull-requests";
    await writeIndexedDesktopSession(home, sessionId, {
      prNumber: 111772,
      prs: [
        { prNumber: 111772, state: "MERGED" },
        { prNumber: 111179, state: "MERGED", dismissed: true },
        ...Array.from({ length: 1_000 }, (_value, index) => ({
          prNumber: index + 1,
          state: "CLOSED",
        })),
      ],
    });

    await expect(listPage({}, home)).resolves.toMatchObject({
      sessions: [
        {
          threadId: sessionId,
          pullRequest: {
            numbers: [...Array.from({ length: 19 }, (_value, index) => index + 982), 111772],
            state: "merged",
          },
          source: "claude-desktop",
        },
      ],
    });
  });

  it.each(["decoder garbage", "newer empty entry"] as const)(
    "reads Desktop custom groups with %s",
    async (scenario) => {
      const home = await createHome();
      const sessionId = "desktop-group";
      await writeIndexedDesktopSession(home, sessionId);
      await writeDesktopGroupStore(home, scenario);
      const page = await listPage({}, home);
      expect(page.sessions[0]).toMatchObject({ threadId: sessionId, source: "claude-desktop" });
      if (scenario === "decoder garbage") {
        expect(page.sessions[0]).toMatchObject({ customGroup: "Release" });
      } else {
        expect(page.sessions[0]).not.toHaveProperty("customGroup");
      }
    },
  );

  it("discovers CLI fallback transcripts and rejects sidechains, foreign entrypoints, and escapes", async () => {
    const home = await createHome();
    const projectDir = projectFile(home);
    const escapedId = "escaped-session";
    const escapedPath = path.join(projectDir, `${escapedId}.jsonl`);
    const externalPath = path.join(home, "outside.jsonl");
    const visible = [
      ["cli-session", "Interactive CLI prompt", "cli"],
      ["sdk-cli-session", "Headless CLI prompt", "sdk-cli"],
      ["sdk-ts-session", "Bidirectional stream-json prompt", "sdk-ts"],
    ] as const;
    const hidden = [
      ["cli-sidechain-session", { entrypoint: "cli", isSidechain: true }],
      ["discovered-sidechain", { entrypoint: "sdk-cli", isSidechain: true }],
      ["foreign-entrypoint-session", { entrypoint: "some-other-tool" }],
    ] satisfies Array<[string, Record<string, unknown>]>;
    await writeProject({
      home,
      entries: [
        {
          sessionId: "sidechain-session",
          fullPath: path.join(projectDir, "sidechain-session.jsonl"),
          isSidechain: true,
        },
        { sessionId: escapedId, fullPath: escapedPath, isSidechain: false },
      ],
      transcripts: {
        "sidechain-session": [message("sidechain-session", "user", "sidechain", 1)],
        "unindexed-session": [message("unindexed-session", "user", "unindexed", 1)],
        ...Object.fromEntries(
          visible.map(([id, text, entrypoint]) => [
            id,
            [
              ...(entrypoint === "cli"
                ? [message(id, "user", "CLI metadata", 1, { entrypoint, isMeta: true })]
                : []),
              message(id, "user", text, 1, { entrypoint, cwd: "/work/cli", version: "2.1.216" }),
            ],
          ]),
        ),
        ...Object.fromEntries(
          hidden.map(([id, extra]) => [id, [message(id, "user", id, 1, extra)]]),
        ),
      },
    });
    await fs.writeFile(
      externalPath,
      `${JSON.stringify(message(escapedId, "user", "outside", 1))}\n`,
    );
    await fs.symlink(externalPath, escapedPath);
    for (const cliSessionId of [
      "sidechain-session",
      "cli-sidechain-session",
      "discovered-sidechain",
    ]) {
      await writeDesktopMetadata(home, cliSessionId, {
        cliSessionId,
        title: "Desktop sidechain",
        isArchived: false,
      });
    }

    const sessions = (await listPage({}, home)).sessions;
    expect(sessions.map((session) => session.threadId).toSorted()).toEqual([
      "cli-session",
      "sdk-cli-session",
      "sdk-ts-session",
    ]);
    for (const [threadId, text] of visible) {
      expect(sessions.find((session) => session.threadId === threadId)).toMatchObject({
        name: text,
        source: "claude-cli",
      });
      await expect(readPage({ threadId, limit: 1 }, home)).resolves.toMatchObject({
        items: [{ text }],
      });
    }
    for (const threadId of [
      "sidechain-session",
      "cli-sidechain-session",
      "discovered-sidechain",
      "foreign-entrypoint-session",
      "unindexed-session",
      escapedId,
    ]) {
      await expect(readPage({ threadId, limit: 1 }, home)).rejects.toThrow(
        "Claude session is unavailable",
      );
    }
    for (const sessionId of [
      "sidechain-session",
      "cli-sidechain-session",
      "discovered-sidechain",
    ]) {
      expect((await listClaudeSessions(home, { sessionId })).records).toEqual([]);
    }
  });

  it("imports indexed CLI titles and colors through a symlinked root", async () => {
    const home = await createHome();
    const transcripts = Object.fromEntries(
      ["custom", "automatic", "prompt"].map((sessionId) => [
        sessionId,
        [
          sdkCliMessage(sessionId, "First prompt"),
          ...(sessionId !== "prompt"
            ? [{ type: "ai-title", aiTitle: "Automatic title", sessionId }]
            : []),
          ...(sessionId === "custom"
            ? [
                { type: "custom-title", customTitle: "Earlier rename", sessionId },
                { type: "custom-title", customTitle: "My renamed session", sessionId },
                { type: "ai-title", aiTitle: "Later automatic title", sessionId },
                { type: "agent-color", agentColor: "red", sessionId },
                { type: "agent-color", agentColor: "blue", sessionId },
                { type: "agent-color", agentColor: "pink", sessionId: "another-session" },
                {
                  type: "custom-title",
                  customTitle: "Wrong session",
                  sessionId: "another-session",
                },
              ]
            : []),
        ],
      ]),
    );
    await writeProject({
      home,
      entries: Object.keys(transcripts).map((sessionId) => ({ sessionId })),
      transcripts,
    });

    const scanHome = await createHome();
    await fs.mkdir(path.join(scanHome, ".claude"));
    await fs.symlink(
      path.join(home, ".claude", "projects"),
      path.join(scanHome, ".claude", "projects"),
    );
    const sessions = (await listPage({}, scanHome)).sessions;
    expect(Object.fromEntries(sessions.map((session) => [session.threadId, session.name]))).toEqual(
      {
        custom: "My renamed session",
        automatic: "Automatic title",
        prompt: "First prompt",
      },
    );
    expect(sessions.find((session) => session.threadId === "custom")).toMatchObject({
      color: "blue",
    });
  });

  it.each([
    { title: "Caf\u00e9 catalog", query: "Caf\u00e9", name: "composed title" },
    { title: "Cafe\u0301 catalog", query: "Caf\u00e9", name: "decomposed title" },
    { title: "Caf\u00e9 catalog", query: "Cafe\u0301", name: "composed title, decomposed query" },
    { title: "Cafe\u0301 catalog", query: "Cafe\u0301", name: "decomposed title and query" },
  ])("matches canonically equivalent $name in search", async ({ title, query }) => {
    const home = await createHome();
    await writeProject({
      home,
      entries: [{ sessionId: "nfc-session" }],
      transcripts: {
        "nfc-session": [
          sdkCliMessage("nfc-session", "First prompt"),
          { type: "custom-title", customTitle: title, sessionId: "nfc-session" },
        ],
      },
    });
    const sessions = (await listPage({ searchTerm: query }, home)).sessions;
    expect(sessions.map((session) => session.threadId)).toEqual(["nfc-session"]);
  });

  it("reads appended metadata beyond the prefix budget and refreshes the cached tail", async () => {
    const home = await createHome();
    const watches = createClaudeCatalogWatchDriver(home);
    const sessionId = "large-colored-session";
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await writeProject({
      home,
      entries: [{ sessionId, summary: "Stale index title" }],
      transcripts: {
        [sessionId]: [
          sdkCliMessage(sessionId, "First prompt"),
          { type: "agent-color", agentColor: "red", sessionId },
          message(sessionId, "assistant", "x".repeat(3 * 1024 * 1024), 2),
          { type: "custom-title", customTitle: "Tail rename", sessionId },
          { type: "ai-title", aiTitle: "Tail automatic title", sessionId },
          { type: "agent-color", agentColor: "green", sessionId },
        ],
      },
    });
    const openSpy = vi.spyOn(fs, "open");
    const first = await listPage({}, home);
    expect(first.sessions[0]).toMatchObject({ name: "Tail rename", color: "green" });
    watches.arm();
    expect(await listPage({}, home)).toEqual(first);
    openSpy.mockClear();
    expect(await listPage({}, home)).toEqual(first);
    expect(openSpy).not.toHaveBeenCalled();

    const transcriptPath = projectFile(home, `${sessionId}.jsonl`);
    await fs.appendFile(
      transcriptPath,
      [
        { type: "custom-title", customTitle: "New tail rename", sessionId },
        { type: "agent-color", agentColor: "orange", sessionId },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    watches.change(transcriptPath);
    expect((await listPage({}, home)).sessions[0]).toMatchObject({
      name: "New tail rename",
      color: "orange",
    });
    await writeDesktopMetadata(home, "colored-cli", {
      cliSessionId: sessionId,
      title: "Desktop title",
    });
    now += 60_001;
    expect((await listPage({}, home)).sessions[0]).toMatchObject({
      name: "Desktop title",
      source: "claude-desktop",
      color: undefined,
    });
  });

  it("serves an unchanged assembled scan without reparsing transcript files", async () => {
    const home = await createHome();
    const sessionIds = ["cached-session-a", "cached-session-b"];
    await writeUnindexedCliSessions(
      home,
      Object.fromEntries(sessionIds.map((sessionId) => [sessionId, sessionId])),
    );
    const spies = (["stat", "lstat", "readdir", "realpath", "open", "readFile"] as const).map(
      (method) => vi.spyOn(fs, method),
    );
    const [first, concurrent] = await Promise.all([listPage({}, home), listPage({}, home)]);
    expect(concurrent).toEqual(first);
    expect(
      spies[2]?.mock.calls.filter(([target]) => target === path.join(home, ".claude", "projects")),
    ).toHaveLength(1);
    const homeCalls = (spy: (typeof spies)[number]) =>
      spy.mock.calls.filter(([target]) => typeof target === "string" && target.startsWith(home));

    // Polls re-read until the watch vouches for coverage; from then on an unchanged tree is free.
    await expectClaudeCatalogQuiescent(home, spies, homeCalls, first);
    const records = await listClaudeSessions(home);
    for (const spy of spies) {
      spy.mockClear();
    }
    expect(await listClaudeSessions(home)).toBe(records);
    for (const spy of spies) {
      expect(homeCalls(spy)).toEqual([]);
    }
  });

  it("does not shorten cache validity for Desktop rows with no captured transcript", async () => {
    const home = await createHome();
    await writeUnindexedCliSessions(home, { existing: "Existing" });
    await writeDesktopMetadata(home, "missing", {
      cliSessionId: "missing-desktop-transcript",
      title: "Missing",
    });
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const openSpy = vi.spyOn(fs, "open");
    const first = await listPage({}, home);
    openSpy.mockClear();

    now += 15_001;
    await expect(listPage({}, home)).resolves.toEqual(first);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("retries a transient project snapshot read on the short I/O recovery bound", async () => {
    const home = await createHome();
    await writeUnindexedCliSessions(home, { recovered: "Recovered" });
    const directory = projectFile(home);
    await writeProject({ home, project: "other", transcripts: {} });
    const otherDirectory = path.join(home, ".claude", "projects", "other");
    const readdir = fs.readdir.bind(fs);
    let failDirectory = true;
    let failOther = false;
    let otherFailures = 0;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (failDirectory && args[0] === directory) {
        failDirectory = false;
        throw new Error("transient directory read failure");
      }
      if (failOther && args[0] === otherDirectory) {
        failOther = false;
        otherFailures += 1;
        throw new Error("another directory read failed");
      }
      return readdir(...args);
    });
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    expect((await listPage({}, home)).sessions).toEqual([]);
    now += 10_000;
    failOther = true;
    await fs.writeFile(path.join(otherDirectory, "dirty"), "changed");
    await expectClaudeCatalogEventually(home, () => expect(otherFailures).toBe(1));
    now += 5_001;
    expect((await listPage({}, home)).sessions).toMatchObject([
      { threadId: "recovered", name: "Recovered" },
    ]);
  });

  it("retries transient index safe-file failures during discovery", async () => {
    const home = await createHome();
    const sessionId = "safe-file-retry";
    const transcriptPath = projectFile(home, `${sessionId}.jsonl`);
    await writeTranscript(home, sessionId, [sdkCliMessage(sessionId, "Recovered")]);
    const targetDir = path.join(path.dirname(transcriptPath), "nested");
    await fs.mkdir(targetDir);
    const targetPath = path.join(targetDir, `${sessionId}.jsonl`);
    await fs.rename(transcriptPath, targetPath);
    await fs.symlink(targetPath, transcriptPath);
    const realpath = fs.realpath.bind(fs);
    let transcriptAttempts = 0;
    vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      if (args[0] === transcriptPath && transcriptAttempts++ === 0) {
        throw new Error("transient transcript realpath failure");
      }
      return await realpath(...args);
    });

    await expect(listPage({}, home)).resolves.toMatchObject({
      sessions: [{ threadId: sessionId }],
    });
    expect(transcriptAttempts).toBe(2);
  });

  it.each(["transcript", "index"] as const)(
    "retries transient %s I/O without a metadata change",
    async (owner) => {
      const home = await createHome();
      const sessionId = "io-retry";
      if (owner === "index") {
        await writeIndexedSession(
          home,
          sessionId,
          { summary: "Recovered", isSidechain: false },
          "Indexed only",
        );
      } else {
        await writeUnindexedCliSessions(home, { [sessionId]: "Recovered" });
      }
      const target =
        owner === "index"
          ? projectFile(home, "sessions-index.json")
          : await fs.realpath(projectFile(home, sessionId + ".jsonl"));
      let attempts = 0;
      const failOnce = (file: unknown) => {
        if (file === target && attempts++ === 0) {
          throw new Error("transient I/O failure");
        }
      };
      if (owner === "index") {
        const read = fs.readFile.bind(fs);
        vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
          failOnce(args[0]);
          return read(...args);
        });
      } else {
        const open = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          failOnce(args[0]);
          return open(...args);
        });
      }
      let now = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      expect((await listPage({}, home)).sessions).toEqual([]);
      now += 15_001;
      expect((await listPage({}, home)).sessions).toMatchObject([
        { threadId: sessionId, name: "Recovered" },
      ]);
      expect(attempts).toBe(2);
    },
  );

  it("bounds actual metadata reads in serial directory order under parallel stats", async () => {
    const home = await createHome();
    const serialNames = await writeBudgetSessions(home);
    await fs.writeFile(projectFile(home, "sessions-index.json"), '{"version":1,"entries":[]}');
    const expected = serialNames.slice(0, 64).toSorted();
    const lstat = fs.lstat.bind(fs);
    let activeLstats = 0;
    let maxConcurrentLstats = 0;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const target = args[0];
      if (typeof target !== "string" || !target.endsWith(".jsonl")) {
        return await lstat(...args);
      }
      activeLstats += 1;
      maxConcurrentLstats = Math.max(maxConcurrentLstats, activeLstats);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      try {
        return await lstat(...args);
      } finally {
        activeLstats -= 1;
      }
    });

    const cold = await listPage({ limit: 100 }, home);
    expect(maxConcurrentLstats).toBeGreaterThan(1);
    expect(cold.sessions.map((session) => session.threadId).toSorted()).toEqual(expected);
  });

  it("evicts a deleted transcript after a complete scan", async () => {
    const home = await createHome();
    const watches = createClaudeCatalogWatchDriver(home);
    const projectDir = projectFile(home);
    const sessionId = "deleted-session";
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    const fixedTime = new Date("2026-07-10T12:00:00.000Z");
    await writeUnindexedCliSessions(home, { [sessionId]: "Alpha" });
    await fs.utimes(transcriptPath, fixedTime, fixedTime);
    await fs.utimes(projectDir, fixedTime, fixedTime);
    const originalStat = await fs.stat(transcriptPath);
    await listPage({}, home);
    watches.arm();
    await listPage({}, home);

    await fs.rm(transcriptPath);
    await fs.utimes(projectDir, fixedTime, fixedTime);
    watches.change(transcriptPath);
    expect((await listPage({}, home)).sessions).toEqual([]);
    await fs.writeFile(transcriptPath, `${JSON.stringify(sdkCliMessage(sessionId, "Bravo"))}\n`);
    await fs.utimes(transcriptPath, fixedTime, fixedTime);
    await fs.utimes(projectDir, fixedTime, fixedTime);
    const recreatedStat = await fs.stat(transcriptPath);
    expect({ mtimeMs: recreatedStat.mtimeMs, size: recreatedStat.size }).toEqual({
      mtimeMs: originalStat.mtimeMs,
      size: originalStat.size,
    });
    const openSpy = vi.spyOn(fs, "open");

    watches.change(transcriptPath);
    expect((await listPage({}, home)).sessions).toMatchObject([
      { threadId: sessionId, name: "Bravo" },
    ]);
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it("pages mixed blocks without overlap through the paired-node transport", async () => {
    const hostId = "node:paired";
    const home = await createHome();
    process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
    const sessionId = "mixed-block-session";
    await writeProject({
      home,
      entries: [{ sessionId, summary: "Mixed blocks", isSidechain: false }],
      transcripts: {
        [sessionId]: (
          [
            [
              "user",
              [
                { type: "text", text: "Original request" },
                { type: "text", text: "Oldest continuation 🦞" },
              ],
            ],
            [
              "user",
              [
                { type: "tool_result", tool_use_id: "call-1", content: "Private tool output" },
                { type: "text", text: "Continue the task" },
              ],
            ],
            [
              "assistant",
              [
                { type: "text", text: "I will check" },
                { type: "thinking", thinking: "Private reasoning" },
                {
                  type: "tool_use",
                  id: "call-2",
                  name: "read",
                  input: { file: "private.txt", padding: "x".repeat(3 * 1024 * 1024) },
                },
              ],
            ],
            [
              "assistant",
              [
                { type: "text", text: "Public continuation" },
                { type: "thinking", thinking: "x".repeat(2 * 1024 * 1024) },
              ],
            ],
          ] satisfies Array<["user" | "assistant", Record<string, unknown>[]]>
        ).map(([role, content], index) => message(sessionId, role, content, index + 1)),
      },
    });
    const runtime = nodeRuntime(
      [{ nodeId: "paired", connected: true, commands: [CLAUDE_SESSION_READ_COMMAND] }],
      vi.fn(async ({ params }: Parameters<PluginRuntime["nodes"]["invoke"]>[0]) =>
        nodePayload(await readPage(params, home)),
      ),
    );
    const provider = captureCatalogProvider(runtime);
    const request = { hostId, threadId: sessionId, limit: 1 };
    const oversized = await provider.read(request);
    expect(oversized.items.map(({ type, truncated }) => ({ type, truncated }))).toEqual([
      { type: "other", truncated: true },
    ]);
    expect(oversized.items[0]?.raw).toBeUndefined();
    let cursor = oversized.nextCursor;
    const items = [];
    for (const limit of [1, 2, 3, 1]) {
      expect(cursor).toEqual(expect.any(String));
      const page = await provider.read({ ...request, cursor, limit });
      expect(page.items.length).toBeLessThanOrEqual(limit);
      items.push(...page.items);
      cursor = page.nextCursor;
      if (items.length === 1) {
        expect(page.items[0]?.text?.length).toBeLessThanOrEqual(1_000_000);
        expect(page.items[0]?.truncated).toBe(true);
        await expect(
          provider.read({ ...request, cursor: cursor?.replace(/^block:\d+:/u, "block:999:") }),
        ).rejects.toThrow("transcript cursor is invalid");
        await fs.appendFile(
          projectFile(home, `${sessionId}.jsonl`),
          `${JSON.stringify(message(sessionId, "assistant", "Appended reply", 5))}\n`,
        );
        expect((await provider.read(request)).items[0]?.text).toBe("Appended reply");
      }
    }
    expect(items.map(({ type, text }) => [type, text])).toEqual([
      ["toolCall", expect.stringContaining("private.txt")],
      ["reasoning", "Private reasoning"],
      ["agentMessage", "I will check"],
      ["userMessage", "Continue the task"],
      ["toolResult", "Private tool output"],
      ["userMessage", "Oldest continuation 🦞"],
      ["userMessage", "Original request"],
    ]);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    expect(cursor).toBeUndefined();
  });

  it("rejects malformed provider read cursors before paired-node I/O", async () => {
    const listNodes = vi.fn(async () => ({ nodes: [] }));
    const provider = captureCatalogProvider({
      nodes: { list: listNodes },
    } as unknown as PluginRuntime);

    for (const cursor of [
      "",
      " wrapped ",
      "x".repeat(257),
      "block:0",
      "block:-1:x",
      "block:1.5:x",
      "block:9007199254740992:x",
      "block:1: ",
    ]) {
      await expect(
        provider.read({
          hostId: "node:node-a",
          threadId: "session-a",
          cursor,
          limit: 1,
        }),
      ).rejects.toThrow("transcript cursor is invalid");
    }
    expect(listNodes).not.toHaveBeenCalled();
  });

  it("forwards paired-node cursors exactly and rejects malformed response cursors", async () => {
    const catalogCursor = "catalog+/=_cursor";
    const transcriptCursor = "transcript+/=_cursor";
    let catalogNextCursor = "catalog+/=_next";
    let transcriptNextCursor = "transcript+/=_next";
    const invoke = vi.fn(async ({ command }: Parameters<PluginRuntime["nodes"]["invoke"]>[0]) => ({
      payloadJSON: JSON.stringify(
        command === CLAUDE_SESSIONS_LIST_COMMAND
          ? { sessions: [], nextCursor: catalogNextCursor }
          : { threadId: "session-a", items: [], nextCursor: transcriptNextCursor },
      ),
    }));
    const provider = captureCatalogProvider(
      nodeRuntime(
        [
          {
            nodeId: "node-a",
            connected: true,
            commands: [CLAUDE_SESSIONS_LIST_COMMAND, CLAUDE_SESSION_READ_COMMAND],
          },
        ],
        invoke,
      ),
    );

    await expect(
      provider.list({ hostIds: ["node:node-a"], cursors: { "node:node-a": catalogCursor } }),
    ).resolves.toMatchObject([{ nextCursor: catalogNextCursor }]);
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: CLAUDE_SESSIONS_LIST_COMMAND,
        params: expect.objectContaining({ cursor: catalogCursor }),
      }),
    );

    await expect(
      provider.read({
        hostId: "node:node-a",
        threadId: "session-a",
        cursor: transcriptCursor,
        limit: 1,
      }),
    ).resolves.toMatchObject({ nextCursor: transcriptNextCursor });
    expect(invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: CLAUDE_SESSION_READ_COMMAND,
        params: expect.objectContaining({ cursor: transcriptCursor }),
      }),
    );

    catalogNextCursor = " wrapped ";
    await expect(provider.list({ hostIds: ["node:node-a"] })).resolves.toMatchObject([
      { error: { code: "NODE_INVOKE_FAILED" } },
    ]);
    transcriptNextCursor = " ";
    await expect(
      provider.read({ hostId: "node:node-a", threadId: "session-a", limit: 1 }),
    ).rejects.toThrow("Claude node returned an invalid transcript page");
  });

  it("pages transcripts identically when every reverse-scan read returns short", async () => {
    const home = await createHome();
    const sessionId = "short-read-session";
    const oldUser = await writeLongPagedTranscript({ home, sessionId });

    // The fixture spans multiple 128 KiB windows; each is filled in 4 KiB reads.
    injectTranscriptShortReads(sessionId, ({ length }) => Math.min(length, 4096));

    const latest = await readPage({ threadId: sessionId, limit: 2 }, home);
    expect(latest.items.map((item) => item.text)).toEqual(["new assistant", "new user"]);
    expect(latest.nextCursor).toEqual(expect.any(String));

    const older = await readPage(
      { threadId: sessionId, limit: 2, cursor: latest.nextCursor },
      home,
    );
    expect(older.items.map((item) => item.text)).toEqual(["old assistant", oldUser]);
    expect(older.nextCursor).toBeUndefined();
    for (const cursor of [` ${latest.nextCursor} `, " ", null]) {
      await expect(readPage({ threadId: sessionId, cursor, limit: 1 }, home)).rejects.toThrow(
        "transcript cursor is invalid",
      );
    }
  });

  it("still reports a truncated transcript when a reverse-scan read hits EOF mid-window", async () => {
    const home = await createHome();
    const sessionId = "truncated-read-session";
    await writeLongPagedTranscript({ home, sessionId, truncated: true });

    // Return one partial reverse read, then simulate truncation with zero bytes.
    injectTranscriptShortReads(sessionId, ({ length, call, firstPosition }) =>
      firstPosition === 0 ? length : call === 0 ? Math.min(length, 8) : 0,
    );

    await expect(readPage({ threadId: sessionId, limit: 2 }, home)).rejects.toThrow(
      "Claude transcript changed while it was being read",
    );
  });

  it("advertises terminal resume only when the store and Claude binary exist", async () => {
    const home = await createHome();
    const commands = createClaudeSessionNodeHostCommands();
    expect(commands.every((command) => command.dangerous === false)).toBe(true);
    await expect(commands[0]?.handle(JSON.stringify({ cursor: " wrapped " }))).rejects.toThrow(
      "catalog cursor is invalid",
    );
    const read = commands.find((command) => command.command === CLAUDE_SESSION_READ_COMMAND);
    await expect(read?.handle(JSON.stringify({ threadId: "invalid/id" }))).rejects.toThrow(
      "threadId is invalid",
    );
    const policy = createClaudeSessionNodeInvokePolicies()[0];
    expect(new Set(policy?.commands)).toEqual(
      new Set([...commands.map((command) => command.command), CLAUDE_CLI_NODE_RUN_COMMAND]),
    );
    if (!policy) {
      throw new Error("expected Claude node invoke policy");
    }
    const invokeNode = vi.fn(async () => ({ ok: true as const, payload: "listed" }));
    expect(policy.handle({ command: CLAUDE_TERMINAL_RESUME_COMMAND, invokeNode } as never)).toEqual(
      { ok: true },
    );
    for (const [terminal, admin, allowed] of [
      [undefined, true, true],
      [true, true, true],
      [false, true, false],
      [undefined, false, false],
    ] as const) {
      expect(
        await policy.handle({
          command: CLAUDE_TERMINAL_START_COMMAND,
          nodeId: "node",
          params: {},
          invokeNode,
          config: {
            gateway: {
              cliAgents: { enabled: true },
              ...(terminal === undefined ? {} : { terminal: { enabled: terminal } }),
            },
          },
          client: { scopes: admin ? ["operator.admin"] : [] },
        }),
      ).toMatchObject({ ok: allowed });
    }
    expect(invokeNode).not.toHaveBeenCalled();
    await expect(
      policy.handle({ command: CLAUDE_SESSIONS_LIST_COMMAND, invokeNode } as never),
    ).resolves.toEqual({ ok: true, payload: "listed" });
    expect(invokeNode).toHaveBeenCalledOnce();
    const availabilityContext = { config: {}, env: { HOME: home } } as never;
    expect(commands.every((command) => command.isAvailable?.(availabilityContext))).toBe(false);
    await fs.mkdir(path.join(home, ".claude", "projects"), { recursive: true });
    expect(
      commands.slice(0, 2).every((command) => command.isAvailable?.(availabilityContext)),
    ).toBe(true);
    expect(commands[2]?.isAvailable?.(availabilityContext)).toBe(false);
    const binDir = path.join(home, "bin");
    await writeClaudeExecutable(binDir);
    if (process.platform === "win32") {
      await fs.writeFile(path.join(binDir, "claude"), "#!/bin/sh\n");
    }
    expect(
      commands[2]?.isAvailable?.({ config: {}, env: { HOME: home, PATH: binDir } } as never),
    ).toBe(true);

    const resume = terminalCommand(CLAUDE_TERMINAL_RESUME_COMMAND);
    await expect(
      resume.handle(JSON.stringify({ threadId: "--bad", cols: 80, rows: 24 }), terminalIo()),
    ).rejects.toThrow("threadId must be a Claude session id");

    const registerSessionCatalog = vi.fn();
    const api = {
      runtime: {},
      registerSessionCatalog,
    } as unknown as OpenClawPluginApi;
    registerClaudeSessionCatalog(api);
    expect(registerSessionCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ id: "claude", label: "Claude Code" }),
    );
  });

  it("builds a local Claude terminal start plan with the initial prompt", async () => {
    const home = await createHome();
    process.env.HOME = home;
    const binDir = path.join(home, "bin");
    const executable = await writeClaudeExecutable(binDir);
    if (process.platform === "win32") {
      await fs.writeFile(path.join(binDir, "claude"), "#!/bin/sh\n");
    }
    process.env.PATH = binDir;
    nodeHostMocks.userShellPaths.set("claude", binDir);
    const runtime = createPluginRuntimeMock();
    const provider = captureCatalogProvider(runtime);
    const start = (params: { cwd: string; initialMessage?: string; nodeId?: string }) =>
      provider.startTerminalSession?.({ agentId: "main", ...params });

    await expect(start({ cwd: "/work/new-session", initialMessage: "--help" })).resolves.toEqual({
      kind: "local",
      argv: [executable, "--", "--help"],
      cwd: "/work/new-session",
      pathEnv: binDir,
      title: "claude",
    });
    await expect(start({ cwd: "/work/blank-session" })).resolves.toMatchObject({
      argv: [executable],
      cwd: "/work/blank-session",
    });
    await expect(start({ cwd: "/work/new-session", nodeId: "paired-node" })).resolves.toEqual({
      kind: "node",
      nodeId: "paired-node",
      command: CLAUDE_TERMINAL_START_COMMAND,
      uploadPathStyle: "native",
      paramsJSON: JSON.stringify({ cwd: "/work/new-session" }),
      cwd: "/work/new-session",
      title: "claude",
    });
    const fresh = terminalCommand(CLAUDE_TERMINAL_START_COMMAND);
    expect(fresh.isAvailable?.({ config: {}, env: { HOME: home, PATH: binDir } })).toBe(true);
    const io = terminalIo();
    await fresh.handle(
      JSON.stringify({ cwd: binDir, initialMessage: "--help", cols: 100, rows: 30 }),
      io,
    );
    expect(nodeHostMocks.runNodePtyCommand).toHaveBeenCalledWith(
      {
        file: executable,
        args: ["--", "--help"],
        cwd: binDir,
        requiredCwd: true,
        pathEnv: binDir,
        cols: 100,
        rows: 30,
      },
      io,
    );
    await expect(
      fresh.handle(
        JSON.stringify({ cwd: binDir, cols: 80, rows: 24, agentId: "remote-agent" }),
        io,
      ),
    ).rejects.toThrow("unknown terminal start parameter");
    const onHost = vi.fn();
    const nodes = createDeferred<Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>>();
    const publication = createDeferred<void>();
    const pending = provider.list({
      onHost,
      waitUntil: publication.resolve,
      listNodes: () => nodes.promise,
    });
    try {
      await publication.promise;
      expect(onHost).toHaveBeenCalledWith(
        expect.objectContaining({ hostId: "gateway:local", canStartTerminal: true, sessions: [] }),
      );
    } finally {
      nodes.reject(new Error("node registry down"));
      await pending;
    }
    expect(await pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostId: "gateway:local", canStartTerminal: true }),
        expect.objectContaining({ hostId: "node:registry", canStartTerminal: false }),
      ]),
    );
    await expect(
      provider.list({
        onHost,
        listNodes: async () => ({
          nodes: [
            ...(
              [
                ["ready", true, CLAUDE_TERMINAL_START_COMMAND],
                ["resume-only", true, CLAUDE_TERMINAL_RESUME_COMMAND],
                ["offline", false, CLAUDE_TERMINAL_START_COMMAND],
              ] as const
            ).map(([nodeId, connected, command]) => ({
              nodeId,
              connected,
              invocableCommands: [command],
            })),
            {
              nodeId: "denied",
              connected: true,
              commands: [CLAUDE_TERMINAL_START_COMMAND],
              invocableCommands: [],
            },
          ],
        }),
      }),
    ).resolves.toEqual([
      expect.objectContaining({ hostId: "gateway:local", canStartTerminal: true, sessions: [] }),
      expect.objectContaining({ hostId: "node:ready", canStartTerminal: true, sessions: [] }),
    ]);
    expect(runtime.nodes.invoke).not.toHaveBeenCalled();
    expect(onHost).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "node:ready", canStartTerminal: true, sessions: [] }),
    );
  });

  it("resolves Claude terminal eligibility and cwd from the node-owned catalog", async () => {
    const home = await createHome();
    process.env.HOME = home;
    const threadId = "node-owned-session";
    await writeIndexedSession(home, threadId, {
      projectPath: "/node/catalog/cwd",
      summary: "Node-owned session",
    });
    const binDir = path.join(home, "bin");
    await writeClaudeExecutable(binDir, "#!/bin/sh\nexit 1\n");
    process.env.PATH = binDir;
    const shellBinDir = path.join(home, "shell-bin");
    const shellExecutable = await writeClaudeExecutable(shellBinDir, "#!/bin/sh\nexit 0\n");
    nodeHostMocks.userShellPaths.set("claude", shellBinDir);
    const command = terminalCommand(CLAUDE_TERMINAL_RESUME_COMMAND);

    await command.handle(
      JSON.stringify({ threadId, cwd: "/caller/cwd", cols: 80, rows: 24 }),
      terminalIo(),
    );

    expect(nodeHostMocks.runNodePtyCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        file: shellExecutable,
        cwd: "/node/catalog/cwd",
        pathEnv: shellBinDir,
      }),
      expect.any(Object),
    );
    await expect(
      command.handle(JSON.stringify({ threadId: "missing", cols: 80, rows: 24 }), terminalIo()),
    ).rejects.toThrow("Claude session cannot be resumed in a terminal");
  });

  it("replaces a broken npm shim with Claude Desktop's newest native binary", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const home = await createHome();
    process.env.HOME = home;
    const sessionId = "claude-session-1";
    await writeIndexedSession(home, sessionId, { projectPath: home, summary: "Resume session" });
    const daemonBinDir = path.join(home, "daemon-bin");
    const shellBinDir = path.join(home, "shell-bin");
    await writeClaudeExecutable(daemonBinDir, "#!/bin/sh\nexit 1\n");
    process.env.PATH = daemonBinDir;
    const provider = captureCatalogProvider({
      config: { current: () => ({}) },
      nodes: { list: async () => ({ nodes: [] }) },
      agent: { session: { listSessionEntries: () => [] } },
    } as unknown as PluginRuntime);

    await writeBrokenClaudeNpmShim(shellBinDir);
    nodeHostMocks.userShellPaths.set("claude", shellBinDir);
    const desktopVersionRoot = path.join(home, "Library/Application Support/Claude/claude-code");
    const desktopBin = (version: string) =>
      path.join(desktopVersionRoot, version, "claude.app/Contents/MacOS");
    for (const version of ["2.1.9", "2.1.10"]) {
      await writeClaudeExecutable(desktopBin(version), "#!/bin/sh\nexit 0\n");
    }
    const desktopExecutable = path.join(desktopBin("2.1.10"), "claude");
    await expect(provider?.list({})).resolves.toMatchObject([
      { sessions: [{ threadId: sessionId, canOpenTerminal: true }] },
    ]);
    await expect(
      provider?.openTerminal?.({ hostId: "gateway:local", threadId: sessionId }),
    ).resolves.toMatchObject({
      kind: "local",
      argv: [desktopExecutable, "--resume", sessionId],
      cwd: home,
      pathEnv: shellBinDir,
    });
    await expect(
      provider?.openTerminal?.({ hostId: "gateway:local", threadId: "missing" }),
    ).rejects.toThrow("Claude session is unavailable");
  });

  it("hides terminal capability when the failed npm shim has no native replacement", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const home = await createHome();
    process.env.HOME = home;
    const sessionId = "claude-session-broken-shim";
    await writeIndexedSession(home, sessionId, {
      projectPath: home,
      summary: "Broken shim session",
    });
    const shellBinDir = path.join(home, "shell-bin");
    await writeBrokenClaudeNpmShim(shellBinDir);
    process.env.PATH = shellBinDir;
    nodeHostMocks.userShellPaths.set("claude", shellBinDir);
    const provider = captureCatalogProvider({
      config: { current: () => ({}) },
      nodes: { list: async () => ({ nodes: [] }) },
    } as unknown as PluginRuntime);

    await expect(provider.list({ allowPartialResults: true })).resolves.toMatchObject([
      { sessions: [{ threadId: sessionId, canOpenTerminal: false }] },
    ]);
    await expect(
      provider.openTerminal?.({ hostId: "gateway:local", threadId: sessionId }),
    ).rejects.toThrow("Claude CLI is unavailable");
  });

  it("keeps remote nodes while isolated state suppresses local HOME discovery", async () => {
    const home = await createHome();
    process.env.HOME = home;
    const invoke = vi.fn(async ({ nodeId }: { nodeId: string }) => ({
      payloadJSON: JSON.stringify({
        sessions: [
          {
            threadId: `remote-${nodeId}`,
            status: "stored",
            source: "claude-cli",
            archived: false,
          },
        ],
      }),
    }));
    const provider = captureCatalogProvider({
      nodes: {
        list: vi.fn().mockResolvedValue({
          nodes: [
            {
              nodeId: "gateway-node",
              displayName: "Gateway node",
              gatewayLocal: true,
              connected: true,
              commands: [CLAUDE_SESSIONS_LIST_COMMAND],
            },
            {
              nodeId: "remote-node",
              displayName: "Remote node",
              connected: true,
              commands: [CLAUDE_SESSIONS_LIST_COMMAND],
            },
          ],
        }),
        invoke,
      },
    } as unknown as PluginRuntime);

    const hosts = await provider.list({ allowProcessHomeFallback: false });

    expect(hosts.map((host) => host.hostId)).toEqual(["node:remote-node"]);
    const isolated = {
      allowProcessHomeFallback: false,
      hostId: "gateway:local",
      threadId: "private-thread",
    };
    for (const operation of [
      () => provider.read(isolated),
      () => provider.continueSession?.(isolated),
      () => provider.openTerminal?.(isolated),
      () =>
        provider.startTerminalSession?.({
          allowProcessHomeFallback: false,
          agentId: "main",
          cwd: process.cwd(),
        }),
    ]) {
      await expect(operation()).rejects.toThrow(
        "local Claude sessions are unavailable in isolated state",
      );
    }
    // Node starts are outside the process-HOME guard: they must surface the
    // truthful capability error, not the isolation rejection.
    await expect(
      provider.startTerminalSession?.({
        allowProcessHomeFallback: false,
        agentId: "main",
        cwd: process.cwd(),
        nodeId: "remote-node",
      }),
    ).resolves.toMatchObject({
      kind: "node",
      nodeId: "remote-node",
      command: CLAUDE_TERMINAL_START_COMMAND,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "remote-node" }));
  });

  it("publishes a paired-node page that finishes after the fail-soft response", async () => {
    vi.useFakeTimers();
    try {
      const invokeResult = createDeferred<unknown>();
      const controller = new AbortController();
      const invoke = vi.fn<PluginRuntime["nodes"]["invoke"]>(() => invokeResult.promise);
      const provider = captureCatalogProvider(
        nodeRuntime(
          [{ nodeId: "slow-node", connected: true, commands: [CLAUDE_SESSIONS_LIST_COMMAND] }],
          invoke,
        ),
      );
      const completions: Promise<void>[] = [];
      const completed = vi.fn();
      const onHost = vi.fn();
      const pending = provider.list({
        hostIds: ["node:slow-node"],
        limitPerHost: 40,
        signal: controller.signal,
        waitUntil: (completion) => {
          completions.push(
            completion.then(() => {
              expect(onHost).toHaveBeenCalledOnce();
              completed();
            }),
          );
        },
        onHost,
      });
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(pending).resolves.toMatchObject([{ error: { code: "NODE_INVOKE_FAILED" } }]);
      expect(completions).toHaveLength(1);
      expect(completed).not.toHaveBeenCalled();
      expect(onHost).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledWith({
        nodeId: "slow-node",
        command: CLAUDE_SESSIONS_LIST_COMMAND,
        params: { limit: 40 },
        timeoutMs: 30_000,
        scopes: ["operator.write"],
        signal: controller.signal,
      });
      invokeResult.resolve(nodePayload({ sessions: [nodeSession("late-thread")] }));
      await Promise.all(completions);
      expect(onHost).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: "node:slow-node",
          sessions: [
            expect.objectContaining({
              threadId: "late-thread",
              canContinue: false,
              canArchive: false,
              canOpenTerminal: false,
            }),
          ],
        }),
      );
      expect(completed).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts paired-node discovery while the local catalog is still reading", async () => {
    const home = await createHome();
    process.env.HOME = home;
    const sessionId = "concurrent-local-session";
    await writeUnindexedCliSessions(home, { [sessionId]: "Local" });
    const openGate = createDeferred<void>();
    const opened = createDeferred<void>();
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      opened.resolve();
      await openGate.promise;
      return await originalOpen(...args);
    });
    const runtimeListNodes = vi.fn(async () => ({ nodes: [] }));
    const requestListNodes = vi.fn(async () => ({ nodes: [] }));
    const provider = captureCatalogProvider({
      nodes: { list: runtimeListNodes },
    } as unknown as PluginRuntime);

    const completions: Promise<void>[] = [];
    const onHost = vi.fn();
    const listing = provider.list({
      listNodes: requestListNodes,
      onHost,
      waitUntil: (completion) => {
        completions.push(completion);
      },
    });
    await opened.promise;
    expect(completions).toHaveLength(1);
    expect(onHost).not.toHaveBeenCalled();
    expect(requestListNodes).toHaveBeenCalledOnce();
    expect(runtimeListNodes).not.toHaveBeenCalled();
    openGate.resolve();
    await expect(listing).resolves.toMatchObject([
      { hostId: "gateway:local", sessions: [expect.objectContaining({ threadId: sessionId })] },
    ]);
    await Promise.all(completions);
    expect(onHost).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "gateway:local",
        sessions: [expect.objectContaining({ threadId: sessionId, canArchive: false })],
      }),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
