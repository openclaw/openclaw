import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const { unexpectedIo } = vi.hoisted(() => ({
  unexpectedIo: () => {
    throw new Error("Unexpected memory or transcript I/O in status-only hook");
  },
}));

// mock-isolation: Status-only hooks must not discover models or boot an agent runtime.
vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  DEFAULT_PROVIDER: "ollama",
  parseModelRef: () => ({ provider: "ollama", model: "qwen3:4b" }),
  resolveAgentEffectiveModelPrimary: () => undefined,
  resolveAgentConfig: unexpectedIo,
  resolveDefaultModelForAgent: unexpectedIo,
  resolveAgentDir: () => "/synthetic/agent",
  resolveAgentWorkspaceDir: () => "/synthetic/workspace",
}));
// mock-isolation: Keep the configured memory policy independent of installed providers.
vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", () => ({
  resolveRememberAcrossConversations: () => false,
}));
// mock-isolation: Supply the recall capability without loading the plugin registry.
vi.mock("openclaw/plugin-sdk/memory-host-core", () => ({
  getMemoryCapabilityRegistration: () => ({
    pluginId: "memory-core",
    capability: { recallToolNames: ["memory_search"] },
  }),
}));
// mock-isolation: A skipped recall must never open a real memory search manager.
vi.mock("openclaw/plugin-sdk/memory-host-search", () => ({
  closeActiveMemorySearchManager: unexpectedIo,
  getActiveMemoryProvider: unexpectedIo,
  getActiveMemorySearchManager: unexpectedIo,
}));
// mock-isolation: Status-only turns must not read or classify stored memory entries.
vi.mock("openclaw/plugin-sdk/memory-core-host-engine-storage", () => ({
  isAutomaticMemoryEntryEligible: unexpectedIo,
  stripMemoryAnnotationCarriers: unexpectedIo,
}));
// mock-isolation: The fixture owns session state; unexpected database I/O must fail.
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  cleanupSessionLifecycleArtifacts: unexpectedIo,
  formatSqliteSessionFileMarker: unexpectedIo,
  parseSqliteSessionFileMarker: unexpectedIo,
  prepareSessionEntryPatch: unexpectedIo,
  deliveryContextFromSession: unexpectedIo,
  sessionDeliveryOrigin: unexpectedIo,
  rethrowIncognitoSessionError: (error: unknown) => {
    throw error;
  },
}));
// mock-isolation: Skipped recall must not load a real transcript reader or its workers.
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  readSessionTranscriptEvents: unexpectedIo,
  readSessionTranscriptRawDelta: unexpectedIo,
}));

type Runtime = OpenClawPluginApi["runtime"];

function setup(mode: "off" | "escalate" = "escalate") {
  const otherEntry = { pluginId: "other-plugin", lines: ["Other plugin status"] };
  const entry: SessionEntry = {
    sessionId: "status-transition",
    updatedAt: 25,
    pluginDebugEntries: [otherEntry],
  };
  const config: OpenClawConfig = {
    agents: { defaults: { model: { primary: "ollama/qwen3:4b" } } },
    memory: { search: { rememberAcrossConversations: false } },
    plugins: {
      slots: { memory: "memory-core" },
      entries: { "active-memory": { config: { mode, agents: ["main"] } } },
    },
  };
  const lookup = vi.fn(async (): Promise<undefined> => undefined);
  const patch = vi.fn<Runtime["agent"]["session"]["prepareSessionEntryPatch"]>(async (params) => {
    Object.assign(entry, await params.prepare(entry, { existingEntry: entry }));
    if (!params.preserveActivity) {
      entry.updatedAt = 999;
    }
    return entry;
  });
  const runtime = {
    config: { current: () => config },
    agent: {
      resolveCliBackendDispatchEligibilityAsync: async () => undefined,
      runEmbeddedAgent: vi.fn(),
      session: {
        resolveStorePath: () => "/synthetic/sessions",
        getSessionEntryAsync: async () => entry,
        prepareSessionEntryPatch: patch,
      },
    },
    state: {
      openKeyedStore: () => ({
        lookup,
        register: async () => {},
        registerIfAbsent: async () => true,
        consume: async () => undefined,
        delete: async () => false,
        entries: async () => [],
        clear: async () => {},
      }),
    },
  } satisfies {
    config: Pick<Runtime["config"], "current">;
    agent: Pick<
      Runtime["agent"],
      "resolveCliBackendDispatchEligibilityAsync" | "runEmbeddedAgent"
    > & {
      session: Pick<
        Runtime["agent"]["session"],
        "resolveStorePath" | "getSessionEntryAsync" | "prepareSessionEntryPatch"
      >;
    };
    state: Pick<Runtime["state"], "openKeyedStore">;
  };
  const on = vi.fn<OpenClawPluginApi["on"]>();
  const api = createTestPluginApi({
    id: "active-memory",
    config,
    pluginConfig: config.plugins?.entries?.["active-memory"]?.config,
    on,
  });
  Object.assign(api.runtime, runtime);
  plugin.register(api);
  const registration = on.mock.calls.find(([name]) => name === "before_prompt_build");
  if (!registration) {
    throw new Error("Active Memory did not register its prompt hook");
  }
  // The registration name fixes the generic handler's concrete event contract.
  const hook = registration[1] as Parameters<typeof api.on<"before_prompt_build">>[1];
  const run = (allowed: boolean) =>
    hook(
      { prompt: "Hello there", messages: [] },
      {
        agentId: "main",
        sessionKey: "agent:main:status-transition",
        trigger: "user",
        messageProvider: "webchat",
        toolAuthority: {
          fingerprint: allowed ? "allowed" : "denied",
          allows: () => allowed,
          assertActive() {},
        },
      },
    );
  return { entry, otherEntry, lookup, patch, runtime, run };
}

describe("Active Memory policy status", () => {
  it.each(["off", "escalate"] as const)(
    "clears a denied turn's status when an allowed %s turn skips recall",
    async (mode) => {
      const fixture = setup(mode);
      await fixture.run(false);
      expect(fixture.entry.pluginDebugEntries).toContainEqual({
        pluginId: "active-memory",
        lines: ["🧩 Active Memory: status=policy-disabled"],
      });

      await fixture.run(true);

      expect(fixture.entry.pluginDebugEntries).toEqual([fixture.otherEntry]);
      expect(fixture.entry.updatedAt).toBe(25);
      expect(fixture.runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
    },
  );

  it("clears stale status before awaited preflight finishes", async () => {
    const fixture = setup();
    await fixture.run(false);
    const entered = Promise.withResolvers<void>();
    const preflight = Promise.withResolvers<undefined>();
    fixture.lookup.mockImplementationOnce(async () => {
      entered.resolve();
      return preflight.promise;
    });
    const pending = fixture.run(true);
    try {
      await entered.promise;
      expect(fixture.entry.pluginDebugEntries).toEqual([fixture.otherEntry]);
      expect(fixture.entry.updatedAt).toBe(25);
    } finally {
      preflight.resolve(undefined);
      await pending;
    }
  });

  it("leaves a model-locked session's status untouched", async () => {
    const fixture = setup();
    await fixture.run(false);
    fixture.entry.modelSelectionLocked = true;
    const before = structuredClone(fixture.entry);
    fixture.lookup.mockClear();
    fixture.patch.mockClear();

    await fixture.run(true);

    expect(fixture.entry).toEqual(before);
    expect(fixture.lookup).not.toHaveBeenCalled();
    expect(fixture.patch).not.toHaveBeenCalled();
    expect(fixture.runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
  });
});
