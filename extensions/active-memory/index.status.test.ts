import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const unexpectedIo = vi.hoisted(() => () => {
  throw new Error("Unexpected model recall, memory or transcript I/O in status-only hook");
});

// mock-isolation: Registration and skipped turns must not load model recall execution.
vi.mock("./recall.js", unexpectedIo);

// mock-isolation: Status-only hooks must not discover models or boot an agent runtime.
vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  DEFAULT_PROVIDER: "ollama",
  parseModelRef: () => ({ provider: "ollama", model: "qwen3:4b" }),
  resolveAgentEffectiveModelPrimary: () => undefined,
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
  deliveryContextFromSession: unexpectedIo,
  sessionDeliveryOrigin: unexpectedIo,
  rethrowIncognitoSessionError: (error: unknown) => {
    throw error;
  },
}));
// mock-isolation: Skipped recall must not load a real transcript reader or its workers.
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  readSessionTranscriptRawDelta: unexpectedIo,
}));

type Agent = OpenClawPluginApi["runtime"]["agent"];

function setup(mode: "off" | "escalate" | "always" = "escalate") {
  const otherEntry = { pluginId: "other-plugin", lines: ["Other plugin status"] };
  const entry: SessionEntry = {
    sessionId: "status-transition",
    updatedAt: 25,
    pluginDebugEntries: [otherEntry],
  };
  const config: OpenClawConfig = {
    plugins: {
      slots: { memory: "memory-core" },
      entries: { "active-memory": { config: { mode, agents: ["main"] } } },
    },
  };
  const lookup = vi.fn(async (): Promise<undefined> => undefined);
  const patch = vi.fn<Agent["session"]["prepareSessionEntryPatch"]>(async (params) => {
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
  } satisfies NonNullable<Parameters<typeof createPluginRuntimeMock>[0]>;
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
  return { entry, otherEntry, lookup, runtime, run };
}

describe("Active Memory policy status", () => {
  it.each(["off", "escalate", "always"] as const)(
    "clears stale status before %s preflight and preserves the cold-import budget",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
      const entered = Promise.withResolvers<void>();
      const preflight = Promise.withResolvers<undefined>();
      const importStarted = Promise.withResolvers<void>();
      const finishImport = Promise.withResolvers<void>();
      if (mode === "always") {
        // mock-isolation: Delay only module availability, without model or database I/O.
        vi.doMock("./recall.js", async () => {
          importStarted.resolve();
          await finishImport.promise;
          return {
            maybeResolveActiveRecall: async () => ({
              status: "ok",
              summary: "The remembered ramen order",
            }),
          };
        });
      }
      const { entry, otherEntry, lookup, run, runtime } = setup(mode);
      await run(false);
      expect(entry.pluginDebugEntries).toContainEqual({
        pluginId: "active-memory",
        lines: ["🧩 Active Memory: status=policy-disabled"],
      });
      lookup.mockImplementationOnce(() => {
        entered.resolve();
        return preflight.promise;
      });
      const pending = run(true);
      try {
        await entered.promise;
        expect([entry.pluginDebugEntries, entry.updatedAt]).toEqual([[otherEntry], 25]);
        if (mode === "always") {
          await vi.advanceTimersByTimeAsync(1_490);
          preflight.resolve(undefined);
          await importStarted.promise;
          await vi.advanceTimersByTimeAsync(100);
          finishImport.resolve();
          expect((await pending)?.prependContext).toContain("The remembered ramen order");
        } else {
          preflight.resolve(undefined);
          await pending;
          expect([entry.pluginDebugEntries, entry.updatedAt]).toEqual([[otherEntry], 25]);
        }
        expect(runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
      } finally {
        preflight.resolve(undefined);
        finishImport.resolve();
        await pending;
        // mock-isolation: Restore the import guard after the cold-import branch.
        vi.doMock("./recall.js", unexpectedIo);
        vi.useRealTimers();
      }
    },
  );
});
