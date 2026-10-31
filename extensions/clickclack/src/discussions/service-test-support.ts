import "./session-authority.test-support.js";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawPluginGatewayEvents, PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  PluginStateActionAuthority,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { vi } from "vitest";
import { ClickClackHttpError, type ClickClackClient } from "../http-client.js";
import type { ClickClackChannel, CoreConfig } from "../types.js";
import { reserveDiscussionBindingGeneration } from "./binding-generation.js";
import { discussionCredentialFingerprint, discussionExternalRef } from "./naming.js";
import {
  registerDiscussionTestTransport,
  type DiscussionMessagePage,
} from "./service-http-transport.test-support.js";
import { ClickClackDiscussionService } from "./service.js";

const { reservedGenerations } = vi.hoisted(() => ({
  reservedGenerations: new WeakMap<PluginRuntime, Map<string, string>>(),
}));
// Observe actual owner decisions without supplying generations or persistence outcomes.
vi.mock("./binding-generation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./binding-generation.js")>();
  return {
    ...actual,
    async reserveDiscussionBindingGeneration(
      params: Parameters<typeof actual.reserveDiscussionBindingGeneration>[0],
    ) {
      const generation = await actual.reserveDiscussionBindingGeneration(params);
      let sessions = reservedGenerations.get(params.runtime);
      if (!sessions) {
        sessions = new Map();
        reservedGenerations.set(params.runtime, sessions);
      }
      sessions.set(params.sessionKey, generation);
      return generation;
    },
  };
});

const TEST_INSTALLATION_ID = "11111111-2222-4333-8444-555555555555";
const TEST_BINDING_GENERATION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const TEST_DESTINATION_IDENTITY = "https://clickclack.example\0wsp_team";
export const MANAGED_CONTRACT_FIELDS = {
  external_managed: false,
  external_ref: "",
  external_url: "",
  sidebar_section: "",
};

export function createDiscussionMemoryStore<T>(): PluginStateSyncKeyedStore<T> {
  const values = new Map<string, { value: T; createdAt: number }>();
  return {
    register(key, value) {
      values.set(key, { value, createdAt: Date.now() });
    },
    registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { value, createdAt: Date.now() });
      return true;
    },
    lookup: (key) => values.get(key)?.value,
    consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    delete: (key) => values.delete(key),
    entries: () =>
      Array.from(values, ([key, entry]) => ({
        key,
        value: entry.value,
        createdAt: entry.createdAt,
      })),
    clear: () => values.clear(),
  };
}

export function asyncDiscussionTestStore<T>(
  openStore: PluginRuntime["state"]["openSyncKeyedStore"],
  options: Parameters<PluginRuntime["state"]["openKeyedStoreV2"]>[0],
  authority?: PluginStateActionAuthority,
): PluginStateKeyedStore<T, 2> {
  if (options.retention === "retained") {
    throw new Error("ClickClack discussion fixture expects a bounded store");
  }
  const store = openStore<T>(options);
  authority?.assertCurrent();
  const observe = (key: string) => ({
    value: store.lookup(key),
    comparison: JSON.stringify(store.entries().find((entry) => entry.key === key) ?? null),
  });
  return {
    observe: async (key) => observe(key),
    compareAndApply: async (key, comparison, intent, compareOptions) => {
      authority?.assertCurrent();
      const current = observe(key);
      if (current.comparison !== comparison) {
        return { status: "conflict", current };
      }
      for (const condition of compareOptions?.conditions ?? []) {
        const conditionStore = openStore({ ...options, namespace: condition.namespace });
        const image = conditionStore.entries().find((entry) => entry.key === condition.key) ?? null;
        if (JSON.stringify(image) !== condition.comparison) {
          return { status: "conflict", current };
        }
      }
      if (intent.action === "keep") {
        return { status: "unchanged" };
      }
      if (intent.action === "set") {
        store.register(key, intent.value);
      } else {
        store.delete(key);
      }
      return { status: "applied" };
    },
    register: async (key, value, opts) => {
      opts?.assertCurrent?.();
      store.register(key, value, opts);
    },
    registerIfAbsent: async (...args) => store.registerIfAbsent(...args),
    lookup: async (...args) => store.lookup(...args),
    lookupMany: async (keys) => keys.map((key) => ({ ok: true, value: store.lookup(key) })),
    consume: async (...args) => store.consume(...args),
    delete: async (key, opts) => {
      opts?.assertCurrent?.();
      return store.delete(key);
    },
    entries: async () => store.entries(),
    entriesInKeyRange: async ({ keyStartInclusive, keyEndExclusive, limit, order }) =>
      store
        .entries()
        .filter((entry) => entry.key >= keyStartInclusive && entry.key < keyEndExclusive)
        .toSorted((left, right) =>
          order === "desc" ? right.key.localeCompare(left.key) : left.key.localeCompare(right.key),
        )
        .slice(0, limit),
    count: async () => store.entries().length,
    deleteIfEqual: async (key, expected) =>
      store.lookup(key) === expected ? store.delete(key) : false,
    moveEntriesFrom: async () => {
      throw new Error("Discussion stores do not move retained entries");
    },
    clear: async () => store.clear(),
  };
}

export function discussionChannel<T extends Partial<ClickClackChannel>>(fields: T) {
  return {
    id: "chn_discussion",
    route_id: "discussion-route",
    workspace_id: "wsp_team",
    name: "discussion",
    kind: "public",
    created_at: "2026-07-19T00:00:00.000Z",
    ...fields,
  };
}

export function discussionConfig(): CoreConfig {
  return {
    channels: {
      clickclack: {
        enabled: true,
        baseUrl: "https://clickclack.example",
        token: "test-token",
        workspace: "main",
        discussions: {
          enabled: true,
          workspace: "team",
          controlUrlBase: "https://control.example/control/",
          section: "Sessions",
        },
      },
    },
  };
}

export function createHarness(
  entry:
    | {
        sessionId?: string;
        label?: string;
        displayName?: string;
        subject?: string;
        category?: string;
        archivedAt?: number;
      }
    | undefined,
  options: {
    gatewayEvents?: Pick<OpenClawPluginGatewayEvents, "onSessionsChanged">;
    startTimer?: boolean;
    openSyncKeyedStore?: PluginRuntime["state"]["openSyncKeyedStore"];
  } = {},
) {
  let sessionEntry = entry;
  const config = discussionConfig();
  const store = createDiscussionMemoryStore<unknown>();
  const generationStore = createDiscussionMemoryStore<unknown>();
  const revokedStore = createDiscussionMemoryStore<unknown>();
  const installationStore = createDiscussionMemoryStore<{ id: string }>();
  installationStore.register("current", { id: TEST_INSTALLATION_ID });
  const openSyncKeyedStore =
    options.openSyncKeyedStore ??
    (vi.fn((storeOptions: { namespace: string }) => {
      if (storeOptions.namespace === "discussion-installation") {
        return installationStore;
      }
      if (storeOptions.namespace === "discussion-binding-generations") {
        return generationStore;
      }
      if (storeOptions.namespace === "discussion-revoked-channels") {
        return revokedStore;
      }
      return store;
    }) as unknown as PluginRuntime["state"]["openSyncKeyedStore"]);
  const runtime = createPluginRuntimeMock({
    config: { current: vi.fn(() => config) },
    state: {
      openSyncKeyedStore,
      openKeyedStoreV2: <T>(
        storeOptions: Parameters<PluginRuntime["state"]["openKeyedStoreV2"]>[0],
        authority?: PluginStateActionAuthority,
      ) => asyncDiscussionTestStore<T>(openSyncKeyedStore, storeOptions, authority),
    },
    agent: {
      session: {
        getSessionEntry: vi.fn(() =>
          sessionEntry ? { sessionId: "session-id", updatedAt: 1, ...sessionEntry } : undefined,
        ),
        getSessionEntryAsync: vi.fn(async () =>
          sessionEntry ? { sessionId: "session-id", updatedAt: 1, ...sessionEntry } : undefined,
        ),
      },
    },
  });
  const createChannel = vi.fn<ClickClackClient["createChannel"]>(async (_workspaceId, input) =>
    discussionChannel(input),
  );
  const updateChannel = vi.fn(
    async (
      _channelId: string,
      patch: Parameters<ClickClackClient["updateChannel"]>[1],
    ): Promise<ClickClackChannel> =>
      discussionChannel({
        name: patch.name ?? "release-planning",
        external_managed: patch.external_managed ?? true,
        external_ref: patch.external_ref ?? "agent:main:main",
        external_url: patch.external_url ?? "https://control.example/control/chat/main",
        sidebar_section: patch.sidebar_section ?? "Projects",
        ...(patch.display_title !== undefined ? { display_title: patch.display_title } : {}),
      }),
  );
  const messagePage = vi.fn<(channelId: string, limit: number) => Promise<DiscussionMessagePage>>(
    async () => ({ messages: [], oldest_seq: 0, has_older: false }),
  );
  const channels = vi.fn<() => Promise<ClickClackChannel[]>>(async () => [
    discussionChannel({
      id: "chn_general",
      route_id: "general-route",
      name: "general",
      ...MANAGED_CONTRACT_FIELDS,
    }),
  ]);
  const workspaces = vi.fn(async () => [
    {
      id: "wsp_team",
      route_id: "team-route",
      slug: "team",
      name: "Team",
      created_at: "2026-07-19T00:00:00.000Z",
    },
  ]);
  const transportBaseUrl = registerDiscussionTestTransport(
    { workspaces, channels, createChannel, updateChannel, messagePage },
    ClickClackHttpError,
  );
  config.channels!.clickclack!.apiBaseUrl = transportBaseUrl;
  const service = new ClickClackDiscussionService(runtime);
  if (options.gatewayEvents || options.startTimer) {
    void service.bindGatewayEvents(options.gatewayEvents, createTestPluginServiceScheduler());
  }
  return {
    runtime,
    service,
    workspaces,
    transportBaseUrl,
    createChannel,
    updateChannel,
    messagePage,
    channels,
    config,
    store,
    generationStore,
    revokedStore,
    setSessionEntry(value: typeof sessionEntry) {
      sessionEntry = value;
    },
  };
}

function testBindingGeneration(runtime: PluginRuntime, sessionKey: string): string {
  const generation = reservedGenerations.get(runtime)?.get(sessionKey);
  if (!generation) {
    throw new Error(`No real discussion generation was reserved for ${sessionKey}`);
  }
  return generation;
}

// A supplied runtime observes real reservation; omitted runtime describes seeded rows only.
export function testExternalRef(sessionKey: string, runtime?: PluginRuntime): string {
  return discussionExternalRef(
    TEST_INSTALLATION_ID,
    sessionKey,
    TEST_DESTINATION_IDENTITY,
    runtime ? testBindingGeneration(runtime, sessionKey) : TEST_BINDING_GENERATION,
  );
}

export async function reserveTestExternalRef(runtime: PluginRuntime, sessionKey: string) {
  const generation = await reserveDiscussionBindingGeneration({
    runtime,
    sessionKey,
    accountId: "default",
    credentialFingerprint: discussionCredentialFingerprint("test-token"),
    destinationIdentity: TEST_DESTINATION_IDENTITY,
  });
  return discussionExternalRef(
    TEST_INSTALLATION_ID,
    sessionKey,
    TEST_DESTINATION_IDENTITY,
    generation,
  );
}
