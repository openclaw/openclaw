import type { SessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import { vi } from "vitest";
import { runCatalogListInline } from "./session-catalog-list-operation.js";
import { catalogFactory } from "./session-catalog-resident.test-support.js";
import type {
  CodexSessionCatalogPage,
  CodexSessionCatalogPageParams,
} from "./session-catalog-types.js";
import {
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  config,
  createCodexTestBindingStore,
  createCatalogTestProvider,
  createControl,
  createRuntime,
} from "./session-catalog.test-helpers.js";

const idleSession = { status: "idle", source: "cli", archived: false };
export function page(ids: string[], nextCursor?: string): CodexSessionCatalogPage {
  return {
    sessions: ids.map((threadId) => ({ ...idleSession, threadId, name: threadId })),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export function observe<T>(promise: Promise<T>) {
  const state = { settled: false };
  const done = promise
    .then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    )
    .finally(() => {
      state.settled = true;
    });
  return { state, done };
}

export async function fixture(homeCount = 1, pluginConfig?: unknown) {
  const { runtime } = createRuntime();
  const base = catalogFactory({ getRuntimeConfig: () => config });
  const primary = (await base.homesForAgent("main"))[0]!;
  const homes = Array.from({ length: homeCount }, (_, index) => ({
    ...primary,
    sourceHomeId: `home-${index}`,
    hostId: index === 0 ? "gateway:local" : `gateway:local:home-${index}`,
    label: `Home ${index}`,
  }));
  const listPage =
    vi.fn<
      (homeId: string, params: CodexSessionCatalogPageParams) => Promise<CodexSessionCatalogPage>
    >();
  listPage.mockResolvedValue(page(["visible"]));
  const snapshot = vi.fn(
    async () => new Map(homes.map((home) => [home.sourceHomeId, new Set(["managed"])])),
  );
  const bindingStore = Object.assign(createCodexTestBindingStore(), {
    managedThreads: { has: vi.fn(async () => false), mark: vi.fn(async () => true), snapshot },
  });
  const provider = createCatalogTestProvider({
    control: {
      ...base,
      homesForAgent: async () => homes,
      forRequest: (_agentId, source) =>
        createControl({ listPage: (params) => listPage(source!.sourceHomeId, params) }),
    },
    runtime,
    startupConfig: config,
    bindingStore,
    getPluginConfig: () => pluginConfig,
  });
  const controller = new AbortController();
  const onHost = vi.fn();
  const publications: Promise<void>[] = [];
  const start = (params: Partial<Parameters<SessionCatalogProvider["list"]>[0]> = {}) => {
    if (!provider.createListOperation) {
      throw new Error("Codex list operation is unavailable");
    }
    return provider.createListOperation({
      agentId: "main",
      limitPerHost: 1,
      hostIds: homes.map((home) => home.hostId),
      signal: controller.signal,
      onHost,
      waitUntil: (completion) => {
        publications.push(completion);
      },
      ...params,
    });
  };
  return { runtime, homes, listPage, snapshot, controller, onHost, publications, start, provider };
}

export async function nodeFixture() {
  const f = await fixture();
  const commands = [CODEX_APP_SERVER_THREADS_LIST_COMMAND];
  const node = { nodeId: "remote", connected: true, connectedAtMs: 1, commands };
  const invoke = vi.mocked(f.runtime.nodes.invoke);
  invoke.mockResolvedValue({ payloadJSON: JSON.stringify(page(["original"])) });
  const read = (params: Partial<Parameters<SessionCatalogProvider["list"]>[0]> = {}) =>
    runCatalogListInline(
      f.start({
        hostIds: undefined,
        allowPartialResults: true,
        listNodes: async () => ({ nodes: [node] }),
        ...params,
      }),
    );
  return { ...f, invoke, read };
}
