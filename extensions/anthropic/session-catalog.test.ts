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
  listLocalClaudeSessionPage,
  readLocalClaudeTranscriptPage,
} from "./session-catalog.js";

type OwnerMethod = "list" | "read" | "continueSession" | "openTerminal";
type OwnerMethods = Pick<RegisteredSessionCatalogProvider, OwnerMethod>;
type SessionCatalogProvider = Omit<RegisteredSessionCatalogProvider, OwnerMethod> & {
  [K in keyof OwnerMethods]: NonNullable<RegisteredSessionCatalogProvider[K]> extends (
    params: infer P,
  ) => infer R
    ? (params: Omit<P, "agentId"> & { agentId?: string }) => R
    : never;
};

function bindTestCatalogOwner(provider: RegisteredSessionCatalogProvider): SessionCatalogProvider {
  return {
    ...provider,
    list: (params) => provider.list({ agentId: "main", ...params }),
    read: (params) => provider.read({ agentId: "main", ...params }),
    ...(provider.continueSession
      ? {
          continueSession: (params) => provider.continueSession!({ agentId: "main", ...params }),
        }
      : {}),
    ...(provider.openTerminal
      ? {
          openTerminal: (params) => provider.openTerminal!({ agentId: "main", ...params }),
        }
      : {}),
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

function captureCatalogProvider(runtime: PluginRuntime): SessionCatalogProvider {
  let provider: SessionCatalogProvider | undefined;
  const runtimeWithSession = {
    ...runtime,
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
const nodeHostMocks = vi.hoisted(() => ({
  runNodePtyCommand: vi.fn(async () => ({ exitCode: 0 })),
  userShellPaths: new Map<string, string>(),
}));

vi.mock("openclaw/plugin-sdk/node-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/node-host")>();
  return {
    ...actual,
    runNodePtyCommand: nodeHostMocks.runNodePtyCommand,
    resolveNodeHostExecutable: (
      command: string,
      options: {
        env?: NodeJS.ProcessEnv;
        pathEnv?: string;
        includeExtensionless?: boolean;
        strategy: "direct" | "fallback" | "prefer";
      },
    ) => {
      const env = options.env ?? process.env;
      const pathEnv = options.pathEnv ?? env.PATH ?? env.Path ?? "";
      const direct = actual.resolveNodeHostExecutable(command, {
        env,
        pathEnv,
        includeExtensionless: options.includeExtensionless,
        strategy: "direct",
      });
      if (direct && options.strategy !== "prefer") {
        return direct;
      }
      const shellPath = nodeHostMocks.userShellPaths.get(command);
      if (!shellPath) {
        return direct;
      }
      const shellExecutable = actual.resolveNodeHostExecutable(command, {
        env,
        pathEnv: shellPath,
        includeExtensionless: options.includeExtensionless,
        strategy: "direct",
      });
      return shellExecutable
        ? { executable: shellExecutable.executable, pathEnv: shellPath }
        : direct;
    },
  };
});

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
  assertion: (page: Awaited<ReturnType<typeof listLocalClaudeSessionPage>>) => void | Promise<void>,
  options: Parameters<typeof listLocalClaudeSessionPage>[0] = {},
) {
  return vi.waitFor(
    async () => {
      const page = await listLocalClaudeSessionPage(options, home);
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
  expected: Awaited<ReturnType<typeof listLocalClaudeSessionPage>>,
) {
  await vi.waitFor(
    async () => {
      for (const spy of spies) {
        spy.mockClear();
      }
      expect(await listLocalClaudeSessionPage({}, home)).toEqual(expected);
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
  entries: Array<Record<string, unknown>>;
  transcripts: Record<string, Array<Record<string, unknown>>>;
}): Promise<void> {
  const projectDir = path.join(params.home, ".claude", "projects", params.project ?? "-workspace");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({ version: 1, entries: params.entries }),
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

async function writeDesktopMetadata(
  home: string,
  name: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions",
    "account",
    "workspace",
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `local_${name}.json`), JSON.stringify(metadata));
}

async function writeIndexedDesktopSession(
  home: string,
  params: {
    sessionId: string;
    localSessionId: string;
    metadataName: string;
    title: string;
    prompt: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { sessionId, localSessionId, metadataName, title, prompt, metadata } = params;
  await writeProject({
    home,
    entries: [
      {
        sessionId,
        fullPath: projectFile(home, `${sessionId}.jsonl`),
        projectPath: "/work/openclaw",
        isSidechain: false,
      },
    ],
    transcripts: { [sessionId]: [message(sessionId, "user", prompt, 1)] },
  });
  await writeDesktopMetadata(home, metadataName, {
    sessionId: localSessionId,
    cliSessionId: sessionId,
    cwd: "/work/openclaw",
    title,
    ...metadata,
  });
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function snappyLiteralChunk(value: Buffer): Buffer {
  if (value.length <= 60) {
    return Buffer.concat([Buffer.from([(value.length - 1) << 2]), value]);
  }
  const length = value.length - 1;
  const lengthBytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    lengthBytes.push(remaining & 0xff);
    remaining = Math.floor(remaining / 0x100);
  }
  return Buffer.concat([Buffer.from([(59 + lengthBytes.length) << 2, ...lengthBytes]), value]);
}

const CLAUDE_GROUP_USER_KEY = Buffer.from("_https://claude.ai\0\x01dframe-store", "latin1");

function levelDbInternalKey(sequence: number, kind = 1): Buffer {
  const trailer = Buffer.alloc(8);
  trailer[0] = kind;
  let remaining = sequence;
  for (let index = 1; index < trailer.length; index += 1) {
    trailer[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 0x100);
  }
  return Buffer.concat([CLAUDE_GROUP_USER_KEY, trailer]);
}

function levelDbDataBlock(
  entries: Array<{ sequence: number; value: string | Buffer; kind?: number }>,
): Buffer {
  const encoded: Buffer[] = [];
  let previousKey: Uint8Array = Buffer.alloc(0);
  for (const entry of entries) {
    const key = levelDbInternalKey(entry.sequence, entry.kind ?? 1);
    let shared = 0;
    while (shared < previousKey.length && previousKey[shared] === key[shared]) {
      shared += 1;
    }
    const value = Buffer.from(entry.value);
    encoded.push(
      encodeVarint(shared),
      encodeVarint(key.length - shared),
      encodeVarint(value.length),
      key.subarray(shared),
      value,
    );
    previousKey = key;
  }
  return Buffer.concat([
    ...encoded,
    Buffer.alloc(4), // one restart at the first entry
    Buffer.from([1, 0, 0, 0]),
  ]);
}

function snappyGroupRecords(groupId: string, groupName: string, localSessionId: string): Buffer {
  const group = `{"id":"${groupId}","name":"${groupName}"}`;
  const assignmentPrefix = `{"code:${localSessionId}":"`;
  const key = levelDbInternalKey(1);
  const valueLength =
    Buffer.byteLength(group) + Buffer.byteLength(assignmentPrefix) + groupId.length + 2;
  const firstChunk = Buffer.concat([
    encodeVarint(0),
    encodeVarint(key.length),
    encodeVarint(valueLength),
    key,
    Buffer.from(`${group}${assignmentPrefix}`),
  ]);
  const groupIdOffset = firstChunk.length - firstChunk.indexOf(groupId);
  const tail = Buffer.concat([Buffer.from('"}'), Buffer.alloc(4), Buffer.from([1, 0, 0, 0])]);
  const decodedLength = firstChunk.length + groupId.length + tail.length;
  return Buffer.concat([
    encodeVarint(decodedLength),
    snappyLiteralChunk(firstChunk),
    Buffer.from([((groupId.length - 1) << 2) | 2, groupIdOffset & 0xff, groupIdOffset >> 8]),
    snappyLiteralChunk(tail),
  ]);
}

function levelDbTable(data: Buffer, compression: 0 | 1): Buffer {
  const dataWithTrailer = Buffer.concat([data, Buffer.from([compression, 0, 0, 0, 0])]);
  const handle = Buffer.concat([encodeVarint(0), encodeVarint(data.length)]);
  const indexEntry = Buffer.concat([Buffer.from([0, 1, handle.length, 0x78]), handle]);
  const index = Buffer.concat([
    indexEntry,
    Buffer.alloc(4), // one restart at the start of the index block
    Buffer.from([1, 0, 0, 0]),
  ]);
  const indexWithTrailer = Buffer.concat([index, Buffer.alloc(5)]);
  const footer = Buffer.alloc(48);
  Buffer.concat([
    encodeVarint(0),
    encodeVarint(0),
    encodeVarint(dataWithTrailer.length),
    encodeVarint(index.length),
  ]).copy(footer);
  return Buffer.concat([dataWithTrailer, indexWithTrailer, footer]);
}

async function writeDesktopGroupStore(
  home: string,
  groupId: string,
  groupName: string,
  localSessionId: string,
): Promise<void> {
  const dir = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "Local Storage",
    "leveldb",
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "000001.ldb"),
    levelDbTable(snappyGroupRecords(groupId, groupName, localSessionId), 1),
  );
}

async function writeDesktopGroupStoreEntries(
  home: string,
  entries: Array<{ sequence: number; value: string | Buffer; kind?: number }>,
): Promise<void> {
  const dir = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "Local Storage",
    "leveldb",
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "000001.ldb"), levelDbTable(levelDbDataBlock(entries), 0));
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
  };
}

function sdkCliMessage(sessionId: string, text: string): Record<string, unknown> {
  return {
    ...message(sessionId, "user", text, 1),
    entrypoint: "sdk-cli",
    cwd: `/work/${sessionId}`,
    version: "2.1.204",
  };
}

async function writeUnindexedCliSessions(
  home: string,
  sessions: Record<string, string>,
  project?: string,
): Promise<void> {
  await writeProject({
    home,
    project,
    entries: [],
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
  await writeProject({
    home: params.home,
    entries: [
      {
        sessionId: params.sessionId,
        fullPath: projectFile(params.home, `${params.sessionId}.jsonl`),
        summary: "Transcript",
        modified: "2026-07-04T00:00:00.000Z",
        isSidechain: false,
      },
    ],
    transcripts: {
      [params.sessionId]: params.truncated
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
    },
  });
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
    ).resolves.toEqual([
      expect.objectContaining({
        hostId: "gateway:local",
        sessions: [
          expect.objectContaining({
            threadId: sessionId,
            name: "Explicit config session",
            source: "claude-cli",
          }),
        ],
      }),
    ]);
  });

  it("adopts a local CLI row with a locked one-shot fork binding", async () => {
    const home = await createHome();
    process.env.HOME = home;
    const sessionId = "claude-source-session";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: projectFile(home, `${sessionId}.jsonl`),
          summary: "Source session",
          projectPath: "/work/source",
        },
      ],
      transcripts: {
        [sessionId]: [
          message(sessionId, "user", "source prompt", 1),
          { type: "custom-title", customTitle: "Renamed source", sessionId },
          { type: "agent-color", agentColor: "purple", sessionId },
        ],
      },
    });
    const createSessionEntry = vi.fn(async (params: Record<string, unknown>) => ({
      key: `agent:main:${String(params.key)}`,
      agentId: "main",
      sessionId: "openclaw-adopted",
      entry: { sessionId: "openclaw-adopted", updatedAt: Date.now() },
    }));
    const config = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    } satisfies OpenClawConfig;
    const provider = captureCatalogProvider(
      createPluginRuntimeMock({
        config: { current: () => config },
        agent: {
          session: {
            listSessionEntries: () => [],
            createSessionEntry,
          },
        },
      }),
    );

    expect(provider?.resolveCreateSession?.({})).toEqual({
      model: "anthropic/claude-opus-4-8",
      agentRuntime: "claude-cli",
    });

    await expect(
      provider?.continueSession?.({ hostId: "gateway:local", threadId: sessionId }),
    ).resolves.toEqual(
      expect.objectContaining({
        sessionKey: expect.stringContaining("plugin:anthropic:catalog-adopt:claude:"),
        upstream: {
          kind: "claude-cli",
          ref: {
            filePath: expect.stringContaining(`${sessionId}.jsonl`),
          },
          marker: { offset: expect.any(Number) },
        },
      }),
    );
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        // Adoption shows the user's /rename via displayName; labels stay unseeded
        // because OpenClaw labels are unique and duplicate CLI titles must adopt.
        displayName: "Renamed source",
        spawnedCwd: "/work/source",
        initialEntry: expect.objectContaining({
          color: "purple",
          cliBackendId: "claude-cli",
          model: "claude-opus-4-8",
          modelSelectionLocked: true,
          pluginOwnerId: "anthropic",
          cliSessionBinding: {
            sessionId,
            forceReuse: true,
            forkNextResume: true,
          },
        }),
      }),
    );
    expect(createSessionEntry.mock.calls[0]?.[0]).not.toHaveProperty("label");
  });

  it("refreshes creation availability when a non-default Claude CLI route changes", () => {
    let config: OpenClawConfig = {};
    const provider = captureCatalogProvider(
      createPluginRuntimeMock({ config: { current: () => config } }),
    );
    expect(provider.resolveCreateSession?.({})).toBeUndefined();

    config = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    };
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
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: projectFile(home, `${sessionId}.jsonl`),
          summary: "Bound session",
          projectPath: "/work/source",
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "source prompt", 1)] },
    });
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

  it("links an adopted row through its catalog marker when the CLI binding is empty", async () => {
    const hosts = await listCatalogWithBoundSession((sessionId) => ({
      cliSessionBindings: { "claude-cli": { sessionId: "" } },
      pluginOwnerId: "anthropic",
      modelSelectionLocked: true,
      pluginExtensions: { anthropic: { sessionCatalog: { sourceThreadId: sessionId } } },
    }));
    expect(hosts?.[0]?.sessions[0]?.sessionKey).toBe("agent:main:claude-bound");
  });

  // An OpenClaw session that merely routes its turns through the Claude CLI keeps
  // its own sidebar row, in whatever group the operator filed it under. Listing
  // its thread here would hide that row inside the Claude catalog instead.
  it("omits a thread an unadopted OpenClaw session drives through the Claude CLI", async () => {
    const hosts = await listCatalogWithBoundSession((sessionId) => ({
      cliSessionBindings: { "claude-cli": { sessionId } },
      category: "Home Assistant",
    }));
    expect(hosts?.[0]?.sessions).toEqual([]);
  });

  it("continues an advertised paired-node CLI row with node-bound placement", async () => {
    const threadId = "node-claude-session";
    const createSessionEntry = vi.fn(async (params: Record<string, unknown>) => ({
      key: String(params.key),
      agentId: "main",
      sessionId: "adopted-node-session",
      entry: { sessionId: "adopted-node-session", updatedAt: 1 },
    }));
    const commands = [
      CLAUDE_SESSIONS_LIST_COMMAND,
      CLAUDE_SESSION_READ_COMMAND,
      CLAUDE_CLI_NODE_RUN_COMMAND,
      CLAUDE_TERMINAL_RESUME_COMMAND,
    ];
    const authorizedCommands = new Set(
      createClaudeSessionNodeInvokePolicies().flatMap((policy) => policy.commands),
    );
    expect(authorizedCommands).toEqual(new Set([...commands, CLAUDE_TERMINAL_START_COMMAND]));
    const nodes = [
      {
        nodeId: "node-a",
        displayName: "Node A",
        connected: true,
        commands,
        invocableCommands: commands.filter((command) => authorizedCommands.has(command)),
      },
    ];
    const invoke = vi.fn(async ({ command }: Parameters<PluginRuntime["nodes"]["invoke"]>[0]) => {
      if (command === CLAUDE_SESSIONS_LIST_COMMAND) {
        return {
          payloadJSON: JSON.stringify({
            sessions: [
              {
                threadId,
                name: "Node source",
                color: "cyan",
                cwd: "/work/on-node",
                status: "stored",
                source: "claude-cli",
                modelProvider: "anthropic",
                pullRequest: { numbers: [1234], state: "open" },
                archived: false,
              },
            ],
          }),
        };
      }
      return {
        payloadJSON: JSON.stringify({
          threadId,
          items: [{ type: "userMessage", text: "history", uuid: "history-1" }],
        }),
      };
    });
    const provider = captureCatalogProvider({
      config: { current: () => ({}) },
      nodes: { list: vi.fn(async () => ({ nodes })), invoke },
      agent: {
        session: {
          listSessionEntries: () => [],
          createSessionEntry,
        },
      },
    } as unknown as PluginRuntime);

    const hosts = await provider?.list({ hostIds: ["node:node-a"] });
    expect(hosts?.[0]?.sessions[0]).toMatchObject({
      threadId,
      pullRequest: { numbers: [1234], state: "open" },
      color: "cyan",
      canContinue: true,
      canOpenTerminal: true,
    });
    await expect(
      provider?.openTerminal?.({ hostId: "node:node-a", threadId }),
    ).resolves.toMatchObject({
      kind: "node",
      nodeId: "node-a",
      command: CLAUDE_TERMINAL_RESUME_COMMAND,
      uploadPathStyle: "native",
      cwd: "/work/on-node",
    });
    await expect(provider?.continueSession?.({ hostId: "node:node-a", threadId })).resolves.toEqual(
      {
        sessionKey: expect.stringContaining("plugin:anthropic:catalog-adopt:claude:"),
        upstream: {
          kind: "claude-cli",
          ref: { nodeId: "node-a", threadId },
          marker: { uuid: "history-1" },
        },
      },
    );
    expect(createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Node source",
        execNode: "node-a",
        execCwd: "/work/on-node",
        spawnedCwd: "/work/on-node",
        initialEntry: expect.objectContaining({
          color: "cyan",
          cliSessionBinding: {
            sessionId: threadId,
            forceReuse: true,
            forkNextResume: true,
          },
          pluginExtensions: {
            anthropic: {
              sessionCatalog: { sourceHostId: "node:node-a", sourceThreadId: threadId },
            },
          },
        }),
      }),
    );
    expect(createSessionEntry.mock.calls[0]?.[0]).not.toHaveProperty("label");
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: CLAUDE_SESSION_READ_COMMAND,
        scopes: ["operator.write"],
      }),
    );
    expect(invoke.mock.calls.every(([request]) => request.scopes?.includes("operator.write"))).toBe(
      true,
    );

    nodes[0]!.invocableCommands = [
      CLAUDE_SESSIONS_LIST_COMMAND,
      CLAUDE_SESSION_READ_COMMAND,
      CLAUDE_CLI_NODE_RUN_COMMAND,
    ];
    await expect(provider?.list({ hostIds: ["node:node-a"] })).resolves.toMatchObject([
      { sessions: [{ threadId, canOpenTerminal: false }] },
    ]);
    await expect(provider?.openTerminal?.({ hostId: "node:node-a", threadId })).rejects.toThrow(
      "paired-node Claude terminal is unavailable",
    );
  });

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
    const runtime = {
      nodes: {
        list: vi.fn(async () => ({ nodes })),
        invoke: vi.fn(async () => ({
          payloadJSON: JSON.stringify({
            sessions: [
              {
                threadId,
                status: "stored",
                source: "claude-desktop",
                modelProvider: "anthropic",
                archived: false,
              },
            ],
          }),
        })),
      },
      config: { current: () => ({}) },
      agent: {
        session: {
          listSessionEntries: () => [],
          createSessionEntry: vi.fn(),
        },
      },
    } as unknown as PluginRuntime;
    const provider = captureCatalogProvider(runtime);

    const hosts = await provider?.list({ hostIds: ["node:node-view"] });
    expect(hosts?.[0]?.sessions[0]?.canContinue).toBe(false);
    await expect(
      provider?.continueSession?.({ hostId: "node:node-view", threadId }),
    ).rejects.toThrow("does not permit Claude CLI session continuation");

    nodes[0]?.commands.push(CLAUDE_CLI_NODE_RUN_COMMAND);
    const blockedHosts = await provider?.list({ hostIds: ["node:node-view"] });
    expect(blockedHosts?.[0]?.sessions[0]?.canContinue).toBe(false);
    await expect(
      provider?.continueSession?.({ hostId: "node:node-view", threadId }),
    ).rejects.toThrow("does not permit Claude CLI session continuation");

    nodes[0]!.invocableCommands = [CLAUDE_SESSIONS_LIST_COMMAND, CLAUDE_CLI_NODE_RUN_COMMAND];
    const readBlockedHosts = await provider?.list({ hostIds: ["node:node-view"] });
    expect(readBlockedHosts?.[0]?.sessions[0]?.canContinue).toBe(false);
    await expect(
      provider?.continueSession?.({ hostId: "node:node-view", threadId }),
    ).rejects.toThrow("does not permit Claude CLI session continuation");

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
      entries: [
        {
          sessionId: "cli-session",
          fullPath: projectFile(home, "cli-session.jsonl"),
          summary: "CLI title",
          modified: "2026-07-01T00:00:00.000Z",
          projectPath: "/work/cli",
          isSidechain: false,
        },
        {
          sessionId: "desktop-session",
          fullPath: projectFile(home, "desktop-session.jsonl"),
          summary: "Index title",
          modified: "2026-07-02T00:00:00.000Z",
          projectPath: "/work/desktop",
          isSidechain: false,
        },
        {
          sessionId: "archived-session",
          fullPath: projectFile(home, "archived-session.jsonl"),
          summary: "Archived",
          modified: "2026-07-03T00:00:00.000Z",
          isSidechain: false,
        },
      ],
      transcripts: {
        "cli-session": [message("cli-session", "user", "CLI", 1)],
        "desktop-session": [message("desktop-session", "user", "Desktop", 1)],
        "archived-session": [message("archived-session", "user", "Archived", 1)],
      },
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

    const first = await listLocalClaudeSessionPage({ limit: 1 }, home);
    expect(first.sessions).toEqual([
      expect.objectContaining({
        threadId: "desktop-session",
        name: "Desktop title",
        cwd: "/desktop/cwd",
        source: "claude-desktop",
        archived: false,
      }),
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(
      listLocalClaudeSessionPage({ limit: 1, cursor: ` ${first.nextCursor} ` }, home),
    ).rejects.toThrow("catalog cursor is invalid");
    const runtime = { nodes: { list: vi.fn() } } as unknown as PluginRuntime;
    const provider = captureCatalogProvider(runtime);
    await expect(
      provider.list({
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": ` ${first.nextCursor} ` },
      }),
    ).rejects.toThrow("cursor for gateway:local is invalid");

    const second = await listLocalClaudeSessionPage({ limit: 1, cursor: first.nextCursor }, home);
    expect(second.sessions).toEqual([
      expect.objectContaining({
        threadId: "cli-session",
        name: "CLI title",
        source: "claude-cli",
      }),
    ]);
    expect(second.nextCursor).toBeUndefined();
    await expect(
      readLocalClaudeTranscriptPage({ threadId: "archived-session", limit: 1 }, home),
    ).rejects.toThrow("Claude session is unavailable");
    await expect(listLocalClaudeSessionPage({ cursor: "x".repeat(257) }, home)).rejects.toThrow(
      "catalog cursor is invalid",
    );
    await expect(listLocalClaudeSessionPage({ cursor: null }, home)).rejects.toThrow(
      "catalog cursor is invalid",
    );
  });

  it("imports a Claude Desktop custom group for its matching catalog row", async () => {
    const home = await createHome();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const sessionId = "desktop-custom-group";
    const localSessionId = "local_11111111-1111-1111-1111-111111111111";
    await writeIndexedDesktopSession(home, {
      sessionId,
      localSessionId,
      metadataName: "custom-group",
      title: "Desktop custom group",
      prompt: "custom group prompt",
    });
    await writeDesktopGroupStore(
      home,
      "cg-22222222-2222-2222-2222-222222222222",
      "Release",
      localSessionId,
    );

    const groupFile = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "Local Storage",
      "leveldb",
      "000001.ldb",
    );
    const fixedGroupTime = new Date("2026-07-20T12:00:00.000Z");
    await fs.utimes(groupFile, fixedGroupTime, fixedGroupTime);
    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [{ threadId: sessionId, customGroup: "Release", source: "claude-desktop" }],
    });
    const readFile = vi.spyOn(fs, "readFile");
    now += 60_001;
    await expectClaudeCatalogEventually(home, (page) =>
      expect(page.sessions[0]?.customGroup).toBe("Release"),
    );
    expect(readFile.mock.calls.filter(([target]) => target === groupFile)).toEqual([]);
    await writeDesktopGroupStore(
      home,
      "cg-22222222-2222-2222-2222-222222222222",
      "Changed",
      localSessionId,
    );
    await fs.utimes(groupFile, fixedGroupTime, fixedGroupTime);
    expect((await listClaudeSessions(home, { forceRefresh: true }))[0]?.customGroup).toBe(
      "Changed",
    );
    const armingSpies = (["lstat", "readdir"] as const).map((method) => vi.spyOn(fs, method));
    await expectClaudeCatalogQuiescent(
      home,
      armingSpies,
      (spy) =>
        spy.mock.calls.filter(([target]) => typeof target === "string" && target.startsWith(home)),
      await listLocalClaudeSessionPage({}, home),
    );
    await writeDesktopGroupStore(
      home,
      "cg-22222222-2222-2222-2222-222222222222",
      "Normal poll update",
      localSessionId,
    );
    now += 60_001;
    expect((await listLocalClaudeSessionPage({}, home)).sessions[0]?.customGroup).toBe(
      "Normal poll update",
    );
  });

  it("retains the current Claude Desktop pull request when history is truncated", async () => {
    const home = await createHome();
    const sessionId = "desktop-pull-requests";
    await writeIndexedDesktopSession(home, {
      sessionId,
      localSessionId: "local_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      metadataName: "pull-requests",
      title: "Desktop pull requests",
      prompt: "pull request prompt",
      metadata: {
        prNumber: 111772,
        prs: [
          { prNumber: 111772, state: "MERGED" },
          { prNumber: 111179, state: "MERGED", dismissed: true },
          ...Array.from({ length: 1_000 }, (_value, index) => ({
            prNumber: index + 1,
            state: "CLOSED",
          })),
        ],
      },
    });

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
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

  it("skips custom group names spliced with decoder garbage", async () => {
    const home = await createHome();
    const sessionId = "desktop-garbage-group";
    const localSessionId = "local_33333333-3333-3333-3333-333333333333";
    const groupId = "cg-44444444-4444-4444-4444-444444444444";
    await writeIndexedDesktopSession(home, {
      sessionId,
      localSessionId,
      metadataName: "garbage-group",
      title: "Desktop garbage group",
      prompt: "garbage group prompt",
    });
    await writeDesktopGroupStoreEntries(home, [
      {
        sequence: 1,
        value:
          `{"id":"${groupId}","name":"Rele\u0012)\fase"}` +
          `{"id":"${groupId}","name":"Release"}{"code:${localSessionId}":"${groupId}"}`,
      },
    ]);
    const page = await listLocalClaudeSessionPage({}, home);
    expect(page.sessions[0]).toMatchObject({
      threadId: sessionId,
      source: "claude-desktop",
      customGroup: "Release",
    });
  });

  it("drops custom groups once a newer entry no longer carries them", async () => {
    const home = await createHome();
    const sessionId = "desktop-deleted-group";
    const localSessionId = "local_99999999-9999-9999-9999-999999999999";
    const groupId = "cg-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await writeIndexedDesktopSession(home, {
      sessionId,
      localSessionId,
      metadataName: "deleted-group",
      title: "Desktop deleted group",
      prompt: "deleted group prompt",
    });
    await writeDesktopGroupStoreEntries(home, [
      {
        sequence: 1,
        value: `{"id":"${groupId}","name":"Release"}{"code:${localSessionId}":"${groupId}"}`,
      },
      { sequence: 2, value: "{}" },
    ]);
    const page = await listLocalClaudeSessionPage({}, home);
    expect(page.sessions[0]).toMatchObject({ threadId: sessionId, source: "claude-desktop" });
    expect(page.sessions[0]).not.toHaveProperty("customGroup");
  });

  it("discovers CLI fallback transcripts and rejects sidechains, foreign entrypoints, and escapes", async () => {
    const home = await createHome();
    const projectDir = projectFile(home);
    const escapedId = "escaped-session";
    const escapedPath = path.join(projectDir, `${escapedId}.jsonl`);
    const externalPath = path.join(home, "outside.jsonl");
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
        "cli-session": [
          {
            ...message(
              "cli-session",
              "user",
              "<local-command-caveat>CLI metadata</local-command-caveat>",
              1,
            ),
            entrypoint: "cli",
            isMeta: true,
          },
          {
            ...message("cli-session", "user", "Interactive CLI prompt", 1),
            entrypoint: "cli",
            cwd: "/work/cli",
            version: "2.1.216",
          },
        ],
        "sdk-cli-session": [
          {
            ...message("sdk-cli-session", "user", "Headless CLI prompt", 1),
            entrypoint: "sdk-cli",
            cwd: "/work/sdk",
            version: "2.1.204",
          },
        ],
        "cli-sidechain-session": [
          {
            ...message("cli-sidechain-session", "user", "interactive sidechain", 1),
            entrypoint: "cli",
            isSidechain: true,
          },
        ],
        "discovered-sidechain": [
          {
            ...message("discovered-sidechain", "user", "headless sidechain", 1),
            entrypoint: "sdk-cli",
            isSidechain: true,
          },
        ],
        "sdk-ts-session": [
          {
            ...message("sdk-ts-session", "user", "Bidirectional stream-json prompt", 1),
            entrypoint: "sdk-ts",
            cwd: "/work/sdk-ts",
            version: "2.1.263",
          },
        ],
        "foreign-entrypoint-session": [
          {
            ...message("foreign-entrypoint-session", "user", "Unrelated tool session", 1),
            entrypoint: "some-other-tool",
          },
        ],
      },
    });
    await fs.writeFile(
      externalPath,
      `${JSON.stringify(message(escapedId, "user", "outside", 1))}\n`,
    );
    await fs.symlink(externalPath, escapedPath);
    await writeDesktopMetadata(home, "sidechain", {
      cliSessionId: "sidechain-session",
      title: "Desktop sidechain",
      isArchived: false,
    });
    await writeDesktopMetadata(home, "cli-sidechain", {
      cliSessionId: "cli-sidechain-session",
      title: "Interactive Desktop sidechain",
      isArchived: false,
    });
    await writeDesktopMetadata(home, "discovered-sidechain", {
      cliSessionId: "discovered-sidechain",
      title: "Headless Desktop sidechain",
      isArchived: false,
    });

    const sessions = (await listLocalClaudeSessionPage({}, home)).sessions;
    expect(sessions.map((session) => session.threadId).toSorted()).toEqual([
      "cli-session",
      "sdk-cli-session",
      "sdk-ts-session",
    ]);
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: "cli-session",
          name: "Interactive CLI prompt",
          source: "claude-cli",
        }),
        expect.objectContaining({
          threadId: "sdk-cli-session",
          name: "Headless CLI prompt",
          source: "claude-cli",
        }),
        expect.objectContaining({
          threadId: "sdk-ts-session",
          name: "Bidirectional stream-json prompt",
          source: "claude-cli",
        }),
      ]),
    );
    for (const [threadId, text] of [
      ["cli-session", "Interactive CLI prompt"],
      ["sdk-cli-session", "Headless CLI prompt"],
      ["sdk-ts-session", "Bidirectional stream-json prompt"],
    ] as const) {
      await expect(readLocalClaudeTranscriptPage({ threadId, limit: 1 }, home)).resolves.toEqual(
        expect.objectContaining({ items: [expect.objectContaining({ text })] }),
      );
    }
    for (const threadId of [
      "sidechain-session",
      "cli-sidechain-session",
      "discovered-sidechain",
      "foreign-entrypoint-session",
      "unindexed-session",
      escapedId,
    ]) {
      await expect(readLocalClaudeTranscriptPage({ threadId, limit: 1 }, home)).rejects.toThrow(
        "Claude session is unavailable",
      );
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
    const sessions = (await listLocalClaudeSessionPage({}, scanHome)).sessions;
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
    const first = await listLocalClaudeSessionPage({}, home);
    expect(first.sessions[0]).toMatchObject({ name: "Tail rename", color: "green" });
    watches.arm();
    expect(await listLocalClaudeSessionPage({}, home)).toEqual(first);
    openSpy.mockClear();
    expect(await listLocalClaudeSessionPage({}, home)).toEqual(first);
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
    expect((await listLocalClaudeSessionPage({}, home)).sessions[0]).toMatchObject({
      name: "New tail rename",
      color: "orange",
    });
    await writeDesktopMetadata(home, "colored-cli", {
      cliSessionId: sessionId,
      title: "Desktop title",
    });
    now += 60_001;
    expect((await listLocalClaudeSessionPage({}, home)).sessions[0]).toMatchObject({
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
    const [first, concurrent] = await Promise.all([
      listLocalClaudeSessionPage({}, home),
      listLocalClaudeSessionPage({}, home),
    ]);
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
    const first = await listLocalClaudeSessionPage({}, home);
    openSpy.mockClear();

    now += 15_001;
    await expect(listLocalClaudeSessionPage({}, home)).resolves.toEqual(first);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("retries a transient project snapshot read on the short I/O recovery bound", async () => {
    const home = await createHome();
    await writeUnindexedCliSessions(home, { recovered: "Recovered" });
    const directory = projectFile(home);
    await writeProject({ home, project: "other", entries: [], transcripts: {} });
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
    expect((await listLocalClaudeSessionPage({}, home)).sessions).toEqual([]);
    now += 10_000;
    failOther = true;
    await fs.writeFile(path.join(otherDirectory, "dirty"), "changed");
    await expectClaudeCatalogEventually(home, () => expect(otherFailures).toBe(1));
    now += 5_001;
    expect((await listLocalClaudeSessionPage({}, home)).sessions).toEqual([
      expect.objectContaining({ threadId: "recovered", name: "Recovered" }),
    ]);
  });

  it("retries transient index safe-file failures during discovery", async () => {
    const home = await createHome();
    const sessionId = "safe-file-retry";
    const transcriptPath = projectFile(home, `${sessionId}.jsonl`);
    await writeProject({
      home,
      entries: [{ sessionId, fullPath: transcriptPath }],
      transcripts: { [sessionId]: [sdkCliMessage(sessionId, "Recovered")] },
    });
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

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: sessionId })],
    });
    expect(transcriptAttempts).toBe(2);
  });

  it("expires a partial discovery scan on the short transient-I/O retry bound", async () => {
    const home = await createHome();
    const sessionId = "partial-scan-retry";
    const transcriptPath = projectFile(home, `${sessionId}.jsonl`);
    await writeUnindexedCliSessions(home, { [sessionId]: "Recovered" });
    const canonicalTranscriptPath = await fs.realpath(transcriptPath);
    const open = fs.open.bind(fs);
    let transcriptAttempts = 0;
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === canonicalTranscriptPath && transcriptAttempts++ === 0) {
        throw new Error("transient transcript open failure");
      }
      return await open(...args);
    });

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toEqual({ sessions: [] });
    now += 15_001;
    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [expect.objectContaining({ threadId: sessionId })],
    });
    expect(transcriptAttempts).toBe(2);
  });

  it("invalidates the assembled scan after same-size same-mtime atomic replacement", async () => {
    const home = await createHome();
    const watches = createClaudeCatalogWatchDriver(home);
    const projectDir = projectFile(home);
    const sessionId = "atomic-replacement";
    const transcriptPath = projectFile(home, `${sessionId}.jsonl`);
    const fixedTime = new Date("2026-07-20T12:00:00.000Z");
    await writeUnindexedCliSessions(home, { [sessionId]: "Alpha" });
    await fs.utimes(transcriptPath, fixedTime, fixedTime);
    await fs.utimes(projectDir, fixedTime, fixedTime);
    const originalStat = await fs.stat(transcriptPath);
    expect((await listLocalClaudeSessionPage({}, home)).sessions[0]?.name).toBe("Alpha");
    watches.arm();
    await listLocalClaudeSessionPage({}, home);

    const replacementPath = path.join(projectDir, "replacement.tmp");
    await fs.writeFile(replacementPath, `${JSON.stringify(sdkCliMessage(sessionId, "Bravo"))}\n`);
    await fs.utimes(replacementPath, fixedTime, fixedTime);
    await fs.rename(replacementPath, transcriptPath);
    await fs.utimes(projectDir, fixedTime, fixedTime);
    const replacementStat = await fs.stat(transcriptPath);
    expect({ mtimeMs: replacementStat.mtimeMs, size: replacementStat.size }).toEqual({
      mtimeMs: originalStat.mtimeMs,
      size: originalStat.size,
    });

    watches.change(transcriptPath);
    expect((await listLocalClaudeSessionPage({}, home)).sessions[0]?.name).toBe("Bravo");
  });

  it("keeps the metadata byte frontier in serial directory order under parallel stats", async () => {
    const home = await createHome();
    const projectDir = projectFile(home);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, "sessions-index.json"), '{"version":1,"entries":[]}');
    const fileBytes = 1024 * 1024;
    const chunkBytes = 16 * 1024;
    const leadingFiller = Buffer.from(`${"x".repeat(chunkBytes - 1)}\n`.repeat(63));
    for (let index = 0; index < 66; index += 1) {
      const sessionId = `budget-${String(index).padStart(2, "0")}`;
      const messageLine = Buffer.from(`${JSON.stringify(sdkCliMessage(sessionId, sessionId))}\n`);
      const finalFillerBytes = fileBytes - leadingFiller.length - messageLine.length;
      const finalFiller = Buffer.from(`${"x".repeat(finalFillerBytes - 1)}\n`);
      await fs.writeFile(
        path.join(projectDir, `${sessionId}.jsonl`),
        Buffer.concat([leadingFiller, finalFiller, messageLine]),
      );
    }
    const serialNames = (await fs.readdir(projectDir))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length));
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

    const cold = await listLocalClaudeSessionPage({ limit: 100 }, home);
    expect(maxConcurrentLstats).toBeGreaterThan(1);
    expect(cold.sessions.map((session) => session.threadId).toSorted()).toEqual(expected);

    const readdir = vi.spyOn(fs, "readdir");
    await fs.utimes(projectDir, new Date(), new Date(Date.now() + 2_000));
    await expectClaudeCatalogEventually(
      home,
      (page) => {
        expect(page.sessions.map((session) => session.threadId).toSorted()).toEqual(expected);
        expect(readdir).toHaveBeenCalledWith(projectDir);
      },
      { limit: 100 },
    );
  });

  it("retries transient index reads without waiting for the file metadata to change", async () => {
    const home = await createHome();
    const projectDir = projectFile(home);
    const indexPath = path.join(projectDir, "sessions-index.json");
    const sessionId = "retry-index-session";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: path.join(projectDir, `${sessionId}.jsonl`),
          summary: "Recovered index",
          isSidechain: false,
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "Indexed only", 1)] },
    });
    const readFile = fs.readFile.bind(fs);
    let failIndexRead = true;
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (failIndexRead && args[0] === indexPath) {
        failIndexRead = false;
        throw new Error("transient index read failure");
      }
      return await readFile(...args);
    });
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    expect((await listLocalClaudeSessionPage({}, home)).sessions).toEqual([]);
    now += 15_001;

    await expect(listLocalClaudeSessionPage({}, home)).resolves.toMatchObject({
      sessions: [{ threadId: sessionId, name: "Recovered index" }],
    });
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
    await listLocalClaudeSessionPage({}, home);
    watches.arm();
    await listLocalClaudeSessionPage({}, home);

    await fs.rm(transcriptPath);
    await fs.utimes(projectDir, fixedTime, fixedTime);
    watches.change(transcriptPath);
    expect((await listLocalClaudeSessionPage({}, home)).sessions).toEqual([]);
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
    expect((await listLocalClaudeSessionPage({}, home)).sessions).toEqual([
      expect.objectContaining({ threadId: sessionId, name: "Bravo" }),
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
    const runtime = createPluginRuntimeMock();
    runtime.nodes.list = vi.fn(async () => ({
      nodes: [{ nodeId: "paired", connected: true, commands: [CLAUDE_SESSION_READ_COMMAND] }],
    }));
    runtime.nodes.invoke = vi.fn(async ({ params }) => ({
      payloadJSON: JSON.stringify(await readLocalClaudeTranscriptPage(params, home)),
    }));
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
    const provider = captureCatalogProvider({
      nodes: {
        list: vi.fn(async () => ({
          nodes: [
            {
              nodeId: "node-a",
              connected: true,
              commands: [CLAUDE_SESSIONS_LIST_COMMAND, CLAUDE_SESSION_READ_COMMAND],
            },
          ],
        })),
        invoke,
      },
    } as unknown as PluginRuntime);

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

    const latest = await readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 2 }, home);
    expect(latest.items.map((item) => item.text)).toEqual(["new assistant", "new user"]);
    expect(latest.nextCursor).toEqual(expect.any(String));

    const older = await readLocalClaudeTranscriptPage(
      { threadId: sessionId, limit: 2, cursor: latest.nextCursor },
      home,
    );
    expect(older.items.map((item) => item.text)).toEqual(["old assistant", oldUser]);
    expect(older.nextCursor).toBeUndefined();
    for (const cursor of [` ${latest.nextCursor} `, " ", null]) {
      await expect(
        readLocalClaudeTranscriptPage({ threadId: sessionId, cursor, limit: 1 }, home),
      ).rejects.toThrow("transcript cursor is invalid");
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

    await expect(
      readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 2 }, home),
    ).rejects.toThrow("Claude transcript changed while it was being read");
  });

  it("advertises terminal resume only when the store and Claude binary exist", async () => {
    const home = await createHome();
    const commands = createClaudeSessionNodeHostCommands();
    expect(commands.map((command) => command.command)).toEqual([
      CLAUDE_SESSIONS_LIST_COMMAND,
      CLAUDE_SESSION_READ_COMMAND,
      CLAUDE_TERMINAL_RESUME_COMMAND,
      CLAUDE_TERMINAL_START_COMMAND,
    ]);
    expect(commands.every((command) => command.dangerous === false)).toBe(true);
    await expect(commands[0]?.handle(JSON.stringify({ cursor: " wrapped " }))).rejects.toThrow(
      "catalog cursor is invalid",
    );
    const policy = createClaudeSessionNodeInvokePolicies()[0];
    expect(policy?.commands).toEqual([
      CLAUDE_SESSIONS_LIST_COMMAND,
      CLAUDE_SESSION_READ_COMMAND,
      CLAUDE_CLI_NODE_RUN_COMMAND,
      CLAUDE_TERMINAL_RESUME_COMMAND,
      CLAUDE_TERMINAL_START_COMMAND,
    ]);
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

    const terminalCommand = commands[2];
    if (!terminalCommand || terminalCommand.duplex !== true) {
      throw new Error("expected duplex Claude terminal command");
    }
    await expect(
      terminalCommand.handle(JSON.stringify({ threadId: "--bad", cols: 80, rows: 24 }), {
        signal: new AbortController().signal,
        emitChunk: async () => {},
        onInput: () => {},
      }),
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

    await expect(
      provider.startTerminalSession?.({
        agentId: "main",
        cwd: "/work/new-session",
        initialMessage: "--help",
      }),
    ).resolves.toEqual({
      kind: "local",
      argv: [executable, "--", "--help"],
      cwd: "/work/new-session",
      pathEnv: binDir,
      title: "claude",
    });
    await expect(
      provider.startTerminalSession?.({
        agentId: "main",
        cwd: "/work/command-prompt",
        initialMessage: "mcp",
      }),
    ).resolves.toMatchObject({ argv: [executable, "--", "mcp"] });
    await expect(
      provider.startTerminalSession?.({ agentId: "main", cwd: "/work/blank-session" }),
    ).resolves.toMatchObject({ argv: [executable], cwd: "/work/blank-session" });
    await expect(
      provider.startTerminalSession?.({
        agentId: "main",
        cwd: "/work/new-session",
        nodeId: "paired-node",
      }),
    ).resolves.toEqual({
      kind: "node",
      nodeId: "paired-node",
      command: CLAUDE_TERMINAL_START_COMMAND,
      uploadPathStyle: "native",
      paramsJSON: JSON.stringify({ cwd: "/work/new-session" }),
      cwd: "/work/new-session",
      title: "claude",
    });
    const fresh = createClaudeSessionNodeHostCommands().find(
      (command) => command.command === CLAUDE_TERMINAL_START_COMMAND,
    )!;
    expect(fresh.isAvailable?.({ config: {}, env: { HOME: home, PATH: binDir } })).toBe(true);
    const io = { signal: new AbortController().signal, emitChunk: vi.fn(), onInput: vi.fn() };
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
            {
              nodeId: "ready",
              connected: true,
              invocableCommands: [CLAUDE_TERMINAL_START_COMMAND],
            },
            {
              nodeId: "resume-only",
              connected: true,
              invocableCommands: [CLAUDE_TERMINAL_RESUME_COMMAND],
            },
            {
              nodeId: "offline",
              connected: false,
              invocableCommands: [CLAUDE_TERMINAL_START_COMMAND],
            },
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
    await writeProject({
      home,
      entries: [
        {
          sessionId: threadId,
          fullPath: projectFile(home, `${threadId}.jsonl`),
          projectPath: "/node/catalog/cwd",
          summary: "Node-owned session",
        },
      ],
      transcripts: { [threadId]: [message(threadId, "user", "hello", 1)] },
    });
    const binDir = path.join(home, "bin");
    await writeClaudeExecutable(binDir, "#!/bin/sh\nexit 1\n");
    process.env.PATH = binDir;
    const shellBinDir = path.join(home, "shell-bin");
    const shellExecutable = await writeClaudeExecutable(shellBinDir, "#!/bin/sh\nexit 0\n");
    nodeHostMocks.userShellPaths.set("claude", shellBinDir);
    const command = createClaudeSessionNodeHostCommands().find(
      (candidate) => candidate.command === CLAUDE_TERMINAL_RESUME_COMMAND,
    );
    if (!command || command.duplex !== true) {
      throw new Error("expected duplex Claude terminal command");
    }

    await command.handle(JSON.stringify({ threadId, cwd: "/caller/cwd", cols: 80, rows: 24 }), {
      signal: new AbortController().signal,
      emitChunk: async () => {},
      onInput: () => {},
    });

    expect(nodeHostMocks.runNodePtyCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        file: shellExecutable,
        cwd: "/node/catalog/cwd",
        pathEnv: shellBinDir,
      }),
      expect.any(Object),
    );
    await expect(
      command.handle(JSON.stringify({ threadId: "missing", cols: 80, rows: 24 }), {
        signal: new AbortController().signal,
        emitChunk: async () => {},
        onInput: () => {},
      }),
    ).rejects.toThrow("Claude session cannot be resumed in a terminal");
  });

  it("replaces a broken npm shim with Claude Desktop's newest native binary", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const home = await createHome();
    process.env.HOME = home;
    const sessionId = "claude-session-1";
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: projectFile(home, `${sessionId}.jsonl`),
          projectPath: home,
          summary: "Resume session",
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "hello", 1)] },
    });
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
    const desktopVersionRoot = path.join(
      home,
      "Library",
      "Application Support",
      "Claude",
      "claude-code",
    );
    for (const version of ["2.1.9", "2.1.10"]) {
      const desktopBinDir = path.join(
        desktopVersionRoot,
        version,
        "claude.app",
        "Contents",
        "MacOS",
      );
      await writeClaudeExecutable(desktopBinDir, "#!/bin/sh\nexit 0\n");
    }
    const desktopExecutable = path.join(
      desktopVersionRoot,
      "2.1.10",
      "claude.app",
      "Contents",
      "MacOS",
      "claude",
    );
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
    await writeProject({
      home,
      entries: [
        {
          sessionId,
          fullPath: projectFile(home, `${sessionId}.jsonl`),
          projectPath: home,
          summary: "Broken shim session",
        },
      ],
      transcripts: { [sessionId]: [message(sessionId, "user", "hello", 1)] },
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
    await expect(
      provider.read({
        allowProcessHomeFallback: false,
        hostId: "gateway:local",
        threadId: "private-thread",
      }),
    ).rejects.toThrow("local Claude sessions are unavailable in isolated state");
    await expect(
      provider.continueSession?.({
        allowProcessHomeFallback: false,
        hostId: "gateway:local",
        threadId: "private-thread",
      }),
    ).rejects.toThrow("local Claude sessions are unavailable in isolated state");
    await expect(
      provider.openTerminal?.({
        allowProcessHomeFallback: false,
        hostId: "gateway:local",
        threadId: "private-thread",
      }),
    ).rejects.toThrow("local Claude sessions are unavailable in isolated state");
    await expect(
      provider.startTerminalSession?.({
        allowProcessHomeFallback: false,
        agentId: "main",
        cwd: process.cwd(),
      }),
    ).rejects.toThrow("local Claude sessions are unavailable in isolated state");
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
      const provider = captureCatalogProvider({
        nodes: {
          list: vi.fn().mockResolvedValue({
            nodes: [
              {
                nodeId: "slow-node",
                connected: true,
                commands: [CLAUDE_SESSIONS_LIST_COMMAND],
              },
            ],
          }),
          invoke,
        },
      } as unknown as PluginRuntime);
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
      invokeResult.resolve({
        payloadJSON: JSON.stringify({
          sessions: [
            {
              threadId: "late-thread",
              status: "stored",
              source: "claude-cli",
              modelProvider: "anthropic",
              archived: false,
            },
          ],
        }),
      });
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
    let releaseOpen = () => {};
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    let reportOpen = () => {};
    const opened = new Promise<void>((resolve) => {
      reportOpen = resolve;
    });
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      reportOpen();
      await openGate;
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
    await opened;
    expect(completions).toHaveLength(1);
    expect(onHost).not.toHaveBeenCalled();
    expect(requestListNodes).toHaveBeenCalledOnce();
    expect(runtimeListNodes).not.toHaveBeenCalled();
    releaseOpen();
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
