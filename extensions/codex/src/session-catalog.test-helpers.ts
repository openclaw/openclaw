// Register narrow mocks before any production imports evaluate the catalog graph.
// oxfmt-ignore
import {
  commandRpcMocks,
  pinnedConnectionMocks,
  transcriptMirrorMocks,
  nodeHostMocks,
} from "./session-catalog.test-mocks.js";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
export { resolveAgentDir, resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createCapturedPluginRegistration,
  createEmptyPluginRegistry,
  createPluginRecord,
  getActivePluginRegistry,
  setActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { SessionCatalogProvider as RegisteredSessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
export { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "../harness.js";
export {
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerLocalHomeDir,
} from "./app-server/auth-start-options.js";
import {
  resolveCodexAppServerUserHomeDir,
  resolveCodexSupervisionAppServerRuntimeOptions,
} from "./app-server/config.js";
export { buildCodexAppServerConnectionFingerprint } from "./app-server/plugin-app-cache-key.js";
import type { CodexThread, CodexThreadItem } from "./app-server/protocol.js";
import { sessionBindingIdentity } from "./app-server/session-binding.js";
import {
  createCodexTestBindingStore,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./app-server/session-binding.test-helpers.js";
import { continueLocalCodexSession as continueLocalCodexSessionRuntime } from "./session-catalog-adoption.js";
import { archiveLocalCodexSession } from "./session-catalog-archive.js";
import {
  createCodexCatalogHomeResolver as createCodexCatalogHomeResolverRuntime,
  type CodexCatalogHome,
} from "./session-catalog-homes.js";
import {
  createCodexSessionCatalogListOperation,
  runCatalogListInline,
} from "./session-catalog-list-operation.js";
import { readCodexSessionTranscript as readCodexSessionTranscriptRuntime } from "./session-catalog-listing.js";
export { CODEX_LOCAL_SESSION_HOST_ID } from "./session-catalog-parsing.js";
export {
  CODEX_TERMINAL_RESUME_COMMAND,
  CODEX_TERMINAL_START_COMMAND,
} from "./session-catalog-terminal.js";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogControlFactory,
} from "./session-catalog-types.js";
import * as catalog from "./session-catalog.js";

export const CODEX_APP_SERVER_THREADS_LIST_COMMAND = "codex.appServer.threads.list.v1";
export const CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND = "codex.appServer.thread.turns.list.v1";
export const CODEX_CATALOG_TRANSCRIPT_READ_COMMAND = "codex.sessionCatalog.transcript.read.v1";
export const CODEX_CLI_SESSION_RESUME_COMMAND = "codex.cli.session.resume";
export const CODEX_NODE_CONTINUE_COMMANDS = [
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
  CODEX_CLI_SESSION_RESUME_COMMAND,
] as const;
const originalPath = process.env.PATH;
export const tempDirs: string[] = [];
const catalogFactories = new Set<ReturnType<typeof catalog.createCodexSessionCatalogControl>>();

beforeEach(() => {
  const stateDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "codex-catalog-owner-"));
  tempDirs.push(stateDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("CODEX_HOME", path.join(stateDir, "codex"));
  nodeHostMocks.runNodePtyCommand.mockClear();
  nodeHostMocks.userShellPaths.clear();
  commandRpcMocks.codexControlRequest.mockReset();
  pinnedConnectionMocks.getClient.mockReset().mockResolvedValue(pinnedConnectionMocks.client);
  pinnedConnectionMocks.releaseClient.mockReset();
  pinnedConnectionMocks.request.mockReset();
  transcriptMirrorMocks.importCodexThreadHistoryToTranscript
    .mockReset()
    .mockResolvedValue(undefined);
});

afterEach(async () => {
  await Promise.all([...catalogFactories].map((factory) => factory.stop()));
  catalogFactories.clear();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetPluginRuntimeStateForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  vi.unstubAllEnvs();
  process.env.PATH = originalPath;
});

type ControlFactoryParams = Omit<
  Parameters<typeof catalog.createCodexSessionCatalogControl>[0],
  "resolveRuntimeOptions"
>;

function createControlFactory(params: Partial<ControlFactoryParams> = {}) {
  const factory = catalog.createCodexSessionCatalogControl({
    getPluginConfig: () => ({ supervision: { enabled: true } }),
    getRuntimeConfig: () => config,
    ...params,
    resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
  });
  catalogFactories.add(factory);
  return factory;
}

function createCodexCatalogHomeResolver(
  params: Omit<
    Parameters<typeof createCodexCatalogHomeResolverRuntime>[0],
    "resolveRuntimeOptions"
  >,
) {
  return createCodexCatalogHomeResolverRuntime({
    ...params,
    resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
  });
}

export function createCodexSessionCatalogControl(params: Partial<ControlFactoryParams> = {}) {
  const runtimeConfig = params.getRuntimeConfig?.() ?? config;
  return createControlFactory(params).forRequest(
    resolveSessionAgentIdsStrict({ config: runtimeConfig }).sessionAgentId,
  );
}

type CatalogControlInput =
  | CodexSessionCatalogControl
  | CodexSessionCatalogControlFactory
  | Pick<CodexSessionCatalogControlFactory, "forRequest">;

function asControlFactory(control: CatalogControlInput): CodexSessionCatalogControlFactory {
  if ("homesForAgent" in control) {
    return control;
  }
  const forRequest = "forRequest" in control ? control.forRequest : () => control;
  return {
    hasActiveWork: () => false,
    disconnect: async () => {},
    forRequest,
    forNode: async () => ({
      control: forRequest("main"),
      sourceHomeId: "node-native",
      codexHome: resolveCodexAppServerUserHomeDir(),
      transport: "stdio",
      assertCurrent: () => {},
    }),
    homesForAgent: async () => [],
    forUpstream: async (agentId) => forRequest(agentId),
  };
}

export async function listCodexSessionCatalog(
  params: Omit<
    Parameters<typeof createCodexSessionCatalogListOperation>[0],
    "control" | "localHomes"
  > & {
    includeLocal?: boolean;
    localHomes?: CodexCatalogHome[];
    control: CatalogControlInput;
  },
) {
  return {
    hosts: await runCatalogListInline(
      createCodexSessionCatalogListOperation({
        ...params,
        localHomes: params.localHomes ?? (params.includeLocal === false ? [] : [undefined]),
        control: asControlFactory(params.control),
      }),
    ),
  };
}

const catalogOwners = new WeakMap<
  CodexAppServerBindingStore,
  ReturnType<typeof createEmptyPluginRegistry>
>();

export function continueLocalCodexSession(
  params: OptionalCatalogAgent<Parameters<typeof continueLocalCodexSessionRuntime>[0]>,
) {
  let registry = catalogOwners.get(params.bindingStore);
  if (!registry) {
    registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: "codex" }));
    registry.agentHarnesses.push({
      pluginId: "codex",
      source: "runtime",
      harness: createCodexAppServerAgentHarness({
        bindingStore: params.bindingStore,
        runtime: params.api.runtime,
      }),
    });
    catalogOwners.set(params.bindingStore, registry);
  }
  if (getActivePluginRegistry() !== registry) {
    setActivePluginRegistry(registry);
  }
  return continueLocalCodexSessionRuntime({
    ...params,
    agentId:
      params.agentId ?? resolveSessionAgentIdsStrict({ config: params.config }).sessionAgentId,
  });
}

export function readCodexSessionTranscript(
  params: OptionalCatalogAgent<Parameters<typeof readCodexSessionTranscriptRuntime>[0]>,
) {
  return readCodexSessionTranscriptRuntime({ ...params, agentId: params.agentId ?? "main" });
}

export function registerCodexSessionCatalog(
  params: Omit<
    Parameters<typeof catalog.registerCodexSessionCatalog>[0],
    "control" | "getPluginConfig" | "resolveRuntimeOptions"
  > & {
    control: CatalogControlInput;
    getPluginConfig?: () => unknown;
  },
) {
  const getPluginConfig = params.getPluginConfig ?? (() => undefined);
  let control = asControlFactory(params.control);
  if (!("homesForAgent" in params.control)) {
    const resolver = createCodexCatalogHomeResolver({
      config: params.getRuntimeConfig() ?? (params.api.config as OpenClawConfig),
      getRuntimeConfig: params.getRuntimeConfig,
      getPluginConfig,
    });
    control = { ...control, homesForAgent: (agentId) => resolver.forAgent(agentId) };
  }
  return catalog.registerCodexSessionCatalog({
    ...params,
    resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
    control,
    getPluginConfig,
  });
}

export function createCodexSessionCatalogNodeHostCommands(
  control: CatalogControlInput,
  bindingStore?: CodexAppServerBindingStore,
) {
  return catalog.createCodexSessionCatalogNodeHostCommands(asControlFactory(control), bindingStore);
}

type SessionRuntime = PluginRuntime["agent"]["session"];
type CreateSessionEntryParams = Parameters<SessionRuntime["createSessionEntry"]>[0];
type CreateSessionEntryResult = Awaited<ReturnType<SessionRuntime["createSessionEntry"]>>;
type PatchSessionEntryParams = Parameters<SessionRuntime["prepareSessionEntryPatch"]>[0];
type SessionEntrySummary = ReturnType<SessionRuntime["listSessionEntries"]>[number];

type OptionalCatalogAgent<T extends { agentId?: string }> = Omit<T, "agentId"> & {
  agentId?: string;
};
type CatalogMethodName = "list" | "read" | "continueSession" | "archive" | "openTerminal";
type CatalogMethod<K extends CatalogMethodName> = (
  params: OptionalCatalogAgent<Parameters<NonNullable<RegisteredSessionCatalogProvider[K]>>[0]>,
) => ReturnType<NonNullable<RegisteredSessionCatalogProvider[K]>>;
type SessionCatalogProvider = {
  [K in keyof RegisteredSessionCatalogProvider]: K extends CatalogMethodName
    ? CatalogMethod<K>
    : RegisteredSessionCatalogProvider[K];
};

function bindTestCatalogOwner(provider: RegisteredSessionCatalogProvider): SessionCatalogProvider {
  const forAgent = <P extends { agentId?: string }>(params: P) => ({ agentId: "main", ...params });
  return {
    ...provider,
    list: (params) => provider.list(forAgent(params)),
    read: (params) => provider.read(forAgent(params)),
    ...(provider.continueSession
      ? { continueSession: (params) => provider.continueSession!(forAgent(params)) }
      : {}),
    ...(provider.archive ? { archive: (params) => provider.archive!(forAgent(params)) } : {}),
    ...(provider.openTerminal
      ? { openTerminal: (params) => provider.openTerminal!(forAgent(params)) }
      : {}),
  } as SessionCatalogProvider;
}

export const config = {} as OpenClawConfig;

export function compatibilityOwnerConfig(owner = "alpha"): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: owner } },
      entries: { alpha: {}, beta: {} },
    },
  };
}

export async function normalizeCodexManifestConfig(
  value: unknown,
): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(
    await fs.readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: JsonSchemaObject };
  const result = validateJsonSchemaValue({
    cacheKey: "codex.session-catalog.manifest-config",
    schema: manifest.configSchema,
    value,
    applyDefaults: true,
  });
  if (!result.ok) {
    throw new Error(
      `Expected valid Codex manifest config: ${result.errors.map((error) => error.text).join(", ")}`,
    );
  }
  return result.value as Record<string, unknown>;
}

export function idleThread(overrides: Partial<CodexThread> = {}): CodexThread {
  return {
    id: "thread-1",
    name: "Continue native task",
    cwd: "/workspace/project",
    projectId: null,
    status: { type: "idle" },
    ...overrides,
  };
}

export function catalogThreadItem(
  id: string,
  overrides: Partial<CodexThreadItem> = {},
): CodexThreadItem {
  return {
    id,
    type: "agentMessage",
    title: null,
    status: null,
    name: null,
    tool: null,
    server: null,
    command: null,
    cwd: null,
    query: null,
    aggregatedOutput: null,
    text: "",
    changes: [],
    ...overrides,
  };
}

export function createControl(overrides: Partial<CodexSessionCatalogControl> = {}) {
  const withPinnedConnection = vi.fn(
    async (run: (value: CodexSessionCatalogControl) => Promise<unknown>) => await run(control),
  ) as unknown as CodexSessionCatalogControl["withPinnedConnection"];
  const control = {
    connectionFingerprint: "catalog-connection",
    withPinnedConnection,
    initialize: vi.fn(async () => undefined),
    requireEligibleThread: vi.fn(async (threadId: string) => idleThread({ id: threadId })),
    listPage: vi.fn(async () => ({ sessions: [] })),
    listDescendantPage: vi.fn(async () => ({ data: [] })),
    listTurnPage: vi.fn(async () => ({ data: [] })),
    listItemPage: vi.fn(async () => ({ data: [] })),
    readThread: vi.fn(async (threadId: string) => idleThread({ id: threadId })),
    archiveThread: vi.fn(async () => undefined),
    ...overrides,
  } as CodexSessionCatalogControl;
  return control;
}

export function createEligibleControl(overrides: Partial<CodexSessionCatalogControl> = {}) {
  return createControl({
    listPage: vi.fn(async () => ({
      sessions: [{ threadId: "thread-1", status: "idle", source: "cli", archived: false as const }],
    })),
    ...overrides,
  });
}

export function adoptedEntry(
  params: {
    sourceThreadId: string;
    sourceHomeId?: string;
    sessionId?: string;
  },
  initializing = false,
) {
  const sessionId = params.sessionId ?? "openclaw-session-existing";
  return {
    sessionId,
    ...(initializing
      ? {
          sessionFile: `/tmp/${sessionId}.jsonl`,
          initializationPending: true,
          spawnedCwd: "/workspace/project",
        }
      : {}),
    updatedAt: 1,
    agentHarnessId: "codex",
    modelSelectionLocked: true,
    pluginExtensions: {
      codex: {
        supervision: {
          sourceThreadId: params.sourceThreadId,
          ...(params.sourceHomeId ? { sourceHomeId: params.sourceHomeId } : {}),
          modelLocked: true,
          ...(initializing ? { initializing: true } : {}),
        },
      },
    },
  } as CreateSessionEntryResult["entry"];
}

export function supervisionSessionInputKey(threadId: string, sourceHomeId?: string): string {
  const digest = createHash("sha256")
    .update(sourceHomeId ? JSON.stringify([sourceHomeId, threadId]) : threadId)
    .digest("hex");
  return `harness:codex:supervision:${digest}`;
}

export function supervisionSessionKey(threadId: string, sourceHomeId?: string): string {
  return `agent:main:${supervisionSessionInputKey(threadId, sourceHomeId)}`;
}

export function supervisionBinding(
  sourceThreadId: string,
  pending = false,
  patch: Partial<CodexAppServerThreadBinding> = {},
): CodexAppServerThreadBinding {
  return {
    threadId: pending ? sourceThreadId : `${sourceThreadId}-branch`,
    connectionScope: "supervision",
    supervisionSourceThreadId: sourceThreadId,
    cwd: "/workspace/project",
    conversationSourceTransferComplete: true,
    preserveNativeModel: true,
    historyCoveredThrough: new Date().toISOString(),
    ...(pending
      ? {
          pendingSupervisionBranch: {
            sourceThreadId,
            connectionFingerprint: "catalog-connection",
          },
        }
      : { model: "gpt-5.4", modelProvider: "openai" }),
    ...patch,
  };
}

export async function seedSupervisionBinding(params: {
  bindingStore: CodexAppServerBindingStore;
  sessionId: string;
  sessionKey: string;
  sourceThreadId: string;
  pending?: boolean;
}): Promise<void> {
  const binding = supervisionBinding(params.sourceThreadId, params.pending);
  const stored = await params.bindingStore.mutate(
    sessionBindingIdentity({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      config,
    }),
    { kind: "set", if: { kind: "absent" }, binding },
  );
  if (!stored) {
    throw new Error(`failed to seed supervision binding for ${params.sourceThreadId}`);
  }
}

export function interruptedAdoptionEntry(params: { sourceThreadId: string; sessionId: string }) {
  return adoptedEntry(params, true);
}

export function createRuntime(
  params: {
    entries?: SessionEntrySummary[];
    nodes?: Array<Record<string, unknown>>;
    invoke?: PluginRuntime["nodes"]["invoke"];
    failAfterCreate?: () => boolean;
  } = {},
) {
  const entries = params.entries ?? [];
  const capturedRuntime = createCapturedPluginRegistration({ id: "codex" }).api.runtime;
  const session = capturedRuntime.agent.session;
  const createSessionEntry = vi.fn(async (createParams: CreateSessionEntryParams) => {
    const agentId = createParams.agentId ?? "main";
    const storePath = resolveStorePath(createParams.cfg.session?.store, { agentId });
    const key = createParams.key.startsWith("agent:")
      ? createParams.key
      : `agent:${agentId}:${createParams.key}`;
    for (const summary of entries.filter((candidate) =>
      candidate.sessionKey.startsWith(`agent:${agentId}:`),
    )) {
      await session.upsertSessionEntry({
        sessionKey: summary.sessionKey,
        storePath,
        entry: { ...summary.entry, updatedAt: Date.now() },
      });
    }
    const refresh = () => {
      const entry = session.getSessionEntry({
        sessionKey: key,
        storePath,
        readConsistency: "latest",
      });
      const index = entries.findIndex((summary) => summary.sessionKey === key);
      if (index >= 0) {
        entries.splice(index, 1);
      }
      if (entry) {
        entries.push({ sessionKey: key, entry });
      }
    };
    try {
      return await session.createSessionEntry({
        ...createParams,
        afterCreate: async (created) => {
          refresh();
          const patch = await createParams.afterCreate?.(created);
          if (params.failAfterCreate?.()) {
            throw new Error("session finalization failed after binding commit");
          }
          if (!patch) {
            throw new Error("catalog fixture requires its initializer's final patch");
          }
          return patch;
        },
      });
    } finally {
      refresh();
    }
  });
  const patchSessionEntry = vi.fn(async (patchParams: PatchSessionEntryParams) => {
    const summary = entries.find((candidate) => candidate.sessionKey === patchParams.sessionKey);
    if (!summary) {
      return null;
    }
    const current = structuredClone(summary.entry);
    const patch = await patchParams.prepare(current, { existingEntry: structuredClone(current) });
    if (!patch) {
      return summary.entry;
    }
    const next = { ...summary.entry, ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        Reflect.deleteProperty(next, key);
      }
    }
    summary.entry = next;
    return next;
  });
  const filterEntries = (prefix?: string) =>
    entries.filter(({ sessionKey }) => !prefix || sessionKey.startsWith(prefix));
  const runtime = {
    modelConfig: capturedRuntime.modelConfig,
    nodes: {
      list: vi.fn(async () => ({ nodes: params.nodes ?? [] })),
      invoke: params.invoke ?? vi.fn(async () => ({})),
    },
    agent: {
      session: {
        getSessionEntry: session.getSessionEntry,
        getSessionEntryAsync: session.getSessionEntryAsync,
        createSessionEntry,
        listSessionEntries: vi.fn((query) =>
          filterEntries(query?.agentId ? `agent:${query.agentId}:` : undefined),
        ),
        listSessionEntriesAsync: vi.fn(async (query) => filterEntries(`agent:${query.agentId}:`)),
        prepareSessionEntryPatch: patchSessionEntry,
      },
    },
  } as unknown as PluginRuntime;
  return { runtime, entries, createSessionEntry, patchSessionEntry };
}

export function archiveTestSession(params: {
  control: CodexSessionCatalogControl;
  agentId?: string;
  config?: OpenClawConfig;
  bindingStore?: CodexAppServerBindingStore;
  runtime?: PluginRuntime;
  threadId?: string;
}) {
  const archiveConfig = params.config ?? config;
  return archiveLocalCodexSession({
    agentId:
      params.agentId ?? resolveSessionAgentIdsStrict({ config: archiveConfig }).sessionAgentId,
    bindingStore: params.bindingStore ?? createCodexTestBindingStore(),
    config: archiveConfig,
    control: params.control,
    runtime: params.runtime ?? createRuntime().runtime,
    threadId: params.threadId ?? "thread-1",
  });
}

export function createGatewayApi(runtime: PluginRuntime, apiConfig: OpenClawConfig = {}) {
  let provider: SessionCatalogProvider | undefined;
  const registerSessionCatalog = vi.fn((candidate: RegisteredSessionCatalogProvider) => {
    provider = bindTestCatalogOwner(candidate);
  });
  const api = {
    config: apiConfig,
    runtime,
    registerSessionCatalog,
  } as unknown as OpenClawPluginApi;
  return { api, getProvider: () => provider, registerSessionCatalog };
}

export function createCatalogTestProvider({
  runtime = createRuntime().runtime,
  startupConfig = {},
  bindingStore = createCodexTestBindingStore(),
  control = createControl(),
  getRuntimeConfig = () => config,
  ...options
}: Partial<Omit<Parameters<typeof registerCodexSessionCatalog>[0], "api">> & {
  runtime?: PluginRuntime;
  startupConfig?: OpenClawConfig;
} = {}) {
  const { api, getProvider } = createGatewayApi(runtime, startupConfig);
  registerCodexSessionCatalog({ api, bindingStore, control, getRuntimeConfig, ...options });
  return getProvider()!;
}

export {
  commandRpcMocks,
  pinnedConnectionMocks,
  transcriptMirrorMocks,
  nodeHostMocks,
  fs,
  fsSync,
  os,
  path,
  resolveSessionAgentIdsStrict,
  resolveCodexAppServerUserHomeDir,
  sessionBindingIdentity,
  createCodexCatalogHomeResolver,
  createCodexTestBindingStore,
  createControlFactory as createCodexSessionCatalogControlFactory,
};
export { createCodexSessionCatalogNodeInvokePolicies } from "./session-catalog.js";
export type {
  CodexAppServerBindingStore,
  CodexAppServerThreadBinding,
  CodexCatalogHome,
  CodexThread,
  OpenClawConfig,
  PluginRuntime,
};
