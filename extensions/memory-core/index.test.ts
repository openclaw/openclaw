import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  OpenClawPluginService,
} from "openclaw/plugin-sdk/core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMemoryFlushPlan } from "./src/flush-plan.js";
import { buildMemoryPromptSection } from "./src/memory-tool-contract.js";
import {
  getMemoryManagerLifecycle,
  markMemoryIndexingLive,
  retainMemoryIndexingAgents,
} from "./src/memory/lifecycle.js";
import type { MemoryCoreRuntimeHost } from "./src/memory/runtime-host.js";

const closeAllMemorySearchManagersMock = vi.hoisted(() => vi.fn(async () => {}));
const closeMemorySearchManagerMock = vi.hoisted(() => vi.fn(async () => {}));
const getMemorySearchManagerMock = vi.hoisted(() => vi.fn(async () => ({ manager: null })));
const authorizeSearchHitsMock = vi.hoisted(() => vi.fn(async ({ hits }) => hits));
const createMemoryRuntimeMock = vi.hoisted(() =>
  vi.fn((_host: MemoryCoreRuntimeHost = {}) => ({
    authorizeSearchHits: authorizeSearchHitsMock,
    closeAllMemorySearchManagers: closeAllMemorySearchManagersMock,
    closeMemorySearchManager: closeMemorySearchManagerMock,
    getMemorySearchManager: getMemorySearchManagerMock,
  })),
);

// mock-isolation: Keep the lazy manager engine outside registration tests.
vi.mock("./src/runtime-provider.js", () => ({
  createMemoryRuntime: createMemoryRuntimeMock,
}));

import plugin from "./index.js";

const hostRuntime = {
  llm: {
    acquireLocalService: async () => undefined,
  },
  state: {
    openKeyedStore: vi.fn(() => ({
      lookup: vi.fn(),
      register: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    })),
  },
} as unknown as OpenClawPluginApi["runtime"];

function hostRuntimeWithConfig(current: () => OpenClawConfig) {
  return createPluginRuntimeMock({
    ...hostRuntime,
    config: { ...hostRuntime.config, current },
  });
}

type ApiOptions = Parameters<typeof createTestPluginApi>[0];
type MemoryCapability = Parameters<OpenClawPluginApi["registerMemoryCapability"]>[0];

function register(overrides: ApiOptions = {}) {
  const api = createTestPluginApi({ runtime: hostRuntime, ...overrides });
  plugin.register(api);
  return api;
}

function captureCapability(overrides: ApiOptions = {}) {
  let captured: MemoryCapability | undefined;
  register({
    ...overrides,
    registerMemoryCapability(capability) {
      captured = capability;
    },
  });
  if (!captured?.promptBuilder || !captured.runtime) {
    throw new Error("expected memory capability");
  }
  return { promptBuilder: captured.promptBuilder, runtime: captured.runtime };
}

function captureMemoryModelContract(initialConfig: OpenClawConfig) {
  const factories = new Map<string, (ctx: unknown) => unknown>();
  const { promptBuilder } = captureCapability({
    config: initialConfig,
    runtime: hostRuntimeWithConfig(() => initialConfig),
    registerTool(factory, options) {
      for (const name of options?.names ?? []) {
        if (typeof factory === "function") {
          factories.set(name, factory as (ctx: unknown) => unknown);
        }
      }
    },
  });
  const context = {
    agentId: "main",
    config: initialConfig,
    getRuntimeConfig: () => initialConfig,
  };
  const search = factories.get("memory_search")?.(context) as AnyAgentTool | undefined;
  const get = factories.get("memory_get")?.(context) as
    | { description: string; parameters: unknown }
    | undefined;
  if (!search || !get) {
    throw new Error("expected memory model contract");
  }
  return { search, get, promptBuilder };
}

function indexConfig(memory?: string): OpenClawConfig {
  return {
    agents: { entries: { main: {}, research: {} } },
    ...(memory ? { plugins: { slots: { memory } } } : {}),
  };
}

function indexFixture(config: OpenClawConfig, configure?: (api: OpenClawPluginApi) => void) {
  const services: OpenClawPluginService[] = [];
  const backgroundTasks: unknown[] = [];
  const disposals: Array<() => void | Promise<void>> = [];
  const api = createTestPluginApi({
    id: "memory-core",
    config,
    runtime: hostRuntime,
    registerService(service) {
      if (service.id !== "memory-core-index") {
        return;
      }
      if (service.apiVersion === 2) {
        throw new Error("Unexpected scheduled service");
      }
      services.push(service);
    },
  });
  api.lifecycle.runInBackgroundContext = (run) => {
    const task = run();
    backgroundTasks.push(task);
    return task;
  };
  api.lifecycle.onDispose = (callback) => {
    disposals.push(callback);
    return () => {};
  };
  configure?.(api);
  plugin.register(api);
  return {
    services,
    backgroundTasks,
    disposals,
    context: { config, stateDir: "unused", logger: api.logger },
  };
}

describe("buildPromptSection", () => {
  function expectRecallGuidance(result: string[], tool: string) {
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain(`run ${tool}`);
    expect(result[1]).toContain("not already present in the current turn");
    expect(result[1]).toContain("Do not repeat memory retrieval");
  }
  it("prepares explicitly owned memory tools without resolving the system agent", () => {
    let systemAgentReads = 0;
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          get systemAgent() {
            systemAgentReads += 1;
            return { agentId: "unrelated" };
          },
        },
        entries: { main: {}, unrelated: {} },
      },
    };
    const { search, get, promptBuilder } = captureMemoryModelContract(config);
    expect(search.description).toContain("MEMORY.md");
    expect(get.description).toContain("MEMORY.md");
    expect(
      promptBuilder({ availableTools: new Set(["memory_search", "memory_get"]), agentId: "main" }),
    ).toContain("## Memory Recall");
    expect(systemAgentReads).toBe(0);
  });

  it("adds project write guidance only for safe host project keys", () => {
    const { promptBuilder } = captureMemoryModelContract({ agents: { entries: { main: {} } } });
    const prompt = (projectKey?: string) =>
      promptBuilder({
        availableTools: new Set(["memory_search"]),
        agentId: "main",
        projectKey,
      }).join("\n");

    expect(prompt("github.com/OpenClaw/OpenClaw")).toContain(
      "<!-- project: github.com/OpenClaw/OpenClaw -->",
    );
    for (const projectKey of [undefined, "path:/tmp/unsafe-->note", "path:/tmp/a\nb"]) {
      expect(prompt(projectKey)).not.toContain("<!-- project:");
    }
  });

  // Curated writes use file tools, so disabling search must not drop the guidance.
  it("keeps project write guidance when memory search is disabled", () => {
    const config = {
      memory: { search: { enabled: false } },
      agents: { entries: { main: {} } },
    } as OpenClawConfig;
    const prompt = captureCapability({
      config,
      runtime: hostRuntimeWithConfig(() => config),
    }).promptBuilder({
      availableTools: new Set(["memory_search", "memory_get"]),
      agentId: "main",
      projectKey: "github.com/OpenClaw/OpenClaw",
    });

    expect(prompt.join("\n")).toContain("<!-- project: github.com/OpenClaw/OpenClaw -->");
  });

  it("describes the two-step flow when both memory tools are available", () => {
    const result = buildMemoryPromptSection({
      availableTools: new Set(["memory_search", "memory_get"]),
    });
    expectRecallGuidance(result, "memory_search");
    expect(result[1]).toContain("for memory-file hits, use memory_get");
    expect(result).toContain(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
    expect(result.at(-1)).toBe("");
  });

  it.each([
    ["memory_search", "then use memory_get"],
    ["memory_get", "run memory_search"],
  ])("limits the guidance to %s when only that tool is available", (tool, excluded) => {
    const result = buildMemoryPromptSection({
      availableTools: new Set([tool]),
    });
    expectRecallGuidance(result, tool);
    expect(result[1]).not.toContain(excluded);
  });

  it.each([
    [[], [], ["sessions_search", "sessions_history"]],
    [["sessions_search"], ["sessions_search"], ["sessions_history"]],
    [["sessions_history"], ["sessions_history"], ["sessions_search"]],
    [["sessions_search", "sessions_history"], ["sessions_search", "sessions_history"], []],
  ])("offers only available session follow-up tools: %j", (sessionTools, included, excluded) => {
    const { search, promptBuilder } = captureMemoryModelContract({
      agents: { entries: { main: {} } },
    });
    const prompt = promptBuilder({
      availableTools: new Set(["memory_search", "memory_get", ...sessionTools]),
      agentId: "main",
    }).join("\n");
    const modelVisibleText = `${search.description}\n${prompt}`;
    for (const name of included) {
      expect(modelVisibleText).toContain(name);
    }
    for (const name of excluded) {
      expect(modelVisibleText).not.toContain(name);
    }
    expect(prompt).toContain("Session search line numbers are not history offsets");
    expect(prompt).toContain("Never read raw transcript files");
    if (sessionTools.length === 2) {
      expect(prompt).toContain("returned sessionKey, messageId, and sessionId");
    }
  });

  it("includes citations-off instruction when citationsMode is off", () => {
    const result = buildMemoryPromptSection({
      availableTools: new Set(["memory_search"]),
      citationsMode: "off",
    });
    expect(result).toContain(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  });

  it.each([
    { label: "base files", extraPaths: [], sessions: false },
    { label: "configured extra paths", extraPaths: ["notes"], sessions: false },
    { label: "session transcripts", extraPaths: [], sessions: true },
  ])("keeps eager, lazy, and prompt contracts aligned for $label", async (sourceCase) => {
    const search = {
      sources: sourceCase.sessions ? ["memory", "sessions"] : ["memory"],
      ...(sourceCase.sessions ? { experimental: { sessionMemory: true } } : {}),
    };
    const config = {
      agents: { entries: { main: { memory: { search } } } },
      memory: { search: { provider: "none", extraPaths: sourceCase.extraPaths } },
    } as OpenClawConfig;
    const lazy = captureMemoryModelContract(config);
    const { createMemoryGetTool, createMemorySearchTool } = await import("./src/tools.js");
    const eagerSearch = createMemorySearchTool({ config, agentId: "main" });
    const eagerGet = createMemoryGetTool({ config, agentId: "main" });
    if (!eagerSearch || !eagerGet) {
      throw new Error("expected eager memory tools");
    }
    expect(lazy.search.parameters).toStrictEqual(eagerSearch.parameters);
    expect(lazy.get.parameters).toStrictEqual(eagerGet.parameters);
    expect(lazy.search.description).toBe(eagerSearch.description);
    expect(lazy.get.description).toBe(eagerGet.description);
    for (const text of [lazy.search.description, lazy.get.description]) {
      expect(text).toContain("MEMORY.md, USER.md");
      expect(text).toContain("recursively under memory/");
      expect(text.includes("configured extra paths")).toBe(sourceCase.extraPaths.length > 0);
      expect(text.length).toBeLessThan(3_000);
    }
    const defaultSearchScope = lazy.search.description.split(". ", 1)[0] ?? "";
    expect(defaultSearchScope.includes("indexed session transcripts")).toBe(sourceCase.sessions);
    expect(lazy.get.description).not.toContain("indexed session transcripts");
    expect(lazy.search.description).toContain("Corpus outcomes cover each requested corpus");
    expect(lazy.search.description).toContain("results are partial");
    expect(lazy.get.description).toContain("status=ok");
    expect(lazy.get.description).toContain("status=not_found");
    expect(lazy.get.description).toContain("results are partial");
  });
});

describe("memory-core plugin runtime registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts snake_case search arguments through the registered lazy tool", () => {
    const { search } = captureMemoryModelContract({});
    const args = { query: "X", min_score: 0.3, max_results: 3 };
    const prepared = search.prepareArguments?.(args) ?? args;
    expect(Value.Check(search.parameters, prepared)).toBe(true);
    expect(prepared).toEqual({ query: "X", minScore: 0.3, maxResults: 3 });
  });

  it("does not resolve prompt config when no memory tools are exposed", () => {
    const current = vi.fn(() => {
      throw new Error("runtime config must remain lazy");
    });
    const { promptBuilder } = captureCapability({ runtime: hostRuntimeWithConfig(current) });

    expect(promptBuilder?.({ availableTools: new Set() })).toStrictEqual([]);
    expect(current).not.toHaveBeenCalled();
  });

  it("registers the dreaming runtime slash command", () => {
    let command: OpenClawPluginCommandDefinition | undefined;
    register({
      registerCommand: (definition) => {
        command = definition;
      },
    });
    expect(command).toMatchObject({
      name: "dreaming",
      acceptsArgs: true,
      exposeSenderIsOwner: true,
      description: expect.stringContaining("Enable or disable"),
    });
  });

  it("registers the standing-intent tool and deterministic prompt hook", () => {
    const toolNames: string[] = [];
    const hooks: string[] = [];
    const subagentRun = vi.fn();
    register({
      runtime: { ...hostRuntime, subagent: { run: subagentRun } } as never,
      registerTool(_factory, options) {
        toolNames.push(...(options?.names ?? []));
      },
      on(hookName) {
        hooks.push(hookName);
      },
    });

    expect(toolNames).toContain("intent");
    expect(hooks).toContain("before_prompt_build");
    expect(subagentRun).not.toHaveBeenCalled();
  });

  it("scopes the dreaming reply hook to scheduled turns across three registrations", () => {
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const replyHookTriggers: unknown[] = [];
      register({
        on(hookName, _handler, options) {
          if (hookName === "before_agent_reply") {
            replyHookTriggers.push(options?.eligibleTriggers);
          }
        },
      });

      expect(replyHookTriggers, `cycle ${cycle}`).toEqual([["heartbeat", "cron"]]);
    }
  });

  it("keeps intent definitions stable and prepares integer arguments for validation", () => {
    const warn = vi.fn();
    let intentFactory:
      | ((ctx: { config?: OpenClawConfig; senderIsOwner?: boolean }) => unknown)
      | undefined;
    register({
      config: {},
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn },
      registerTool(factory, options) {
        if (
          options?.names?.includes("intent") &&
          typeof factory !== "function" &&
          "contextVersion" in factory
        ) {
          expect(factory.contextVersion).toBe(2);
          intentFactory = (ctx) => factory.create({ ...ctx, assertInvocationCurrent: () => {} });
        }
      },
    });
    if (!intentFactory) {
      throw new Error("expected standing-intent tool factory");
    }

    expect(intentFactory({ senderIsOwner: true })).toBeNull();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "memory-core: intent tool unavailable: runtime config is unavailable for this turn",
    );

    const ownerTool = intentFactory({ config: {}, senderIsOwner: true }) as AnyAgentTool;
    expect(ownerTool).toMatchObject({ name: "intent" });
    for (const senderIsOwner of [false, undefined]) {
      expect(intentFactory({ config: {}, senderIsOwner })).toMatchObject({
        name: ownerTool.name,
        description: ownerTool.description,
        parameters: ownerTool.parameters,
      });
    }
    for (const maxFires of ["3", 3]) {
      const prepared = ownerTool.prepareArguments?.({
        action: "create",
        maxFires,
        cooldownSeconds: "0",
      });
      expect(prepared).toEqual({ action: "create", maxFires: 3, cooldownSeconds: 0 });
      expect(Value.Check(ownerTool.parameters, prepared)).toBe(true);
    }
    for (const maxFires of ["abc", "3.5", "-1", "0"]) {
      expect(() => ownerTool.prepareArguments?.({ action: "create", maxFires })).toThrow(
        "maxFires must be a positive integer",
      );
    }
    expect(ownerTool.description).toContain("system injects the reminder automatically");
    expect(ownerTool.description).toContain("Use scheduled tasks for time-based reminders");
    expect(ownerTool.description).not.toMatch(/\b(?:cron|automations)\b/u);
    expect(ownerTool.parameters).not.toHaveProperty("properties.channelScope");
    expect(ownerTool.parameters).toMatchObject({
      properties: {
        scope: {
          type: "string",
          enum: ["conversation", "channel", "anywhere"],
          default: "channel",
        },
        senderScope: {
          enum: ["sender", "anyone"],
          default: "sender",
        },
      },
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // Runs before any case below marks process-wide indexing live.
  it("leaves cold-start indexing demand-driven until a manager has run", async () => {
    const config = indexConfig("memory-core");
    const {
      services: [service],
      backgroundTasks,
      context,
    } = indexFixture(config);
    if (!service) {
      throw new Error("Expected the memory index service");
    }
    expect(retainMemoryIndexingAgents(["main", "research"])).toEqual([]);
    await service.start(context);
    expect(backgroundTasks).toEqual([]);
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();

    // A watched manager opened by a search or turn makes later restarts restore it.
    markMemoryIndexingLive("main");
    await service.stop?.(context);
    await service.start(context);
    await Promise.all(backgroundTasks);
    expect(getMemorySearchManagerMock.mock.calls).toEqual([[{ cfg: config, agentId: "main" }]]);
  });

  it.each(["memory-core", "honcho", "none"])(
    "starts configured indexes only for the selected memory slot: %s",
    async (owner) => {
      markMemoryIndexingLive("main");
      markMemoryIndexingLive("research");
      const config = indexConfig(owner);
      const { services, backgroundTasks, context } = indexFixture(config);
      for (const service of services) {
        await service.start(context);
      }
      await Promise.all(backgroundTasks);
      expect(getMemorySearchManagerMock.mock.calls).toEqual(
        owner === "memory-core"
          ? [[{ cfg: config, agentId: "main" }], [{ cfg: config, agentId: "research" }]]
          : [],
      );
    },
  );

  it.each([
    { cleanupOwner: "stop", cleanupFails: false },
    { cleanupOwner: "stop", cleanupFails: true },
    { cleanupOwner: "dispose", cleanupFails: false },
    { cleanupOwner: "dispose", cleanupFails: true },
  ])(
    "drains managers after tracked activation rejects ($cleanupOwner, cleanup failure: $cleanupFails)",
    async ({ cleanupOwner, cleanupFails }) => {
      markMemoryIndexingLive("main");
      const activationFailure = new Error("plugin retired after activation");
      const cleanupFailure = new Error("memory manager cleanup failed");
      const config = indexConfig();
      const lifecycle = getMemoryManagerLifecycle();
      const previousPrepare = lifecycle.prepare;
      const previousReload = lifecycle.reload;
      const drain = vi.fn(async () => ({ errors: cleanupFails ? [cleanupFailure] : [] }));
      lifecycle.prepare = () => drain;
      if (cleanupFails) {
        closeAllMemorySearchManagersMock.mockRejectedValueOnce(cleanupFailure);
      }
      // Forced retirement can reject the tracked call after its callback acquired managers.
      function runInBackgroundContext<T>(run: () => T): T;
      function runInBackgroundContext(run: () => unknown) {
        const result = run();
        if (!(result instanceof Promise)) {
          return result;
        }
        const tracked = result.then(() => {
          throw activationFailure;
        });
        void tracked.catch(() => {});
        return tracked;
      }
      try {
        const {
          services: [service],
          disposals,
          context,
        } = indexFixture(config, (api) => {
          api.lifecycle.runInBackgroundContext = runInBackgroundContext;
        });
        if (!service?.stop || disposals.length === 0) {
          throw new Error("Expected memory index cleanup owners");
        }
        const stop = service.stop.bind(service);
        await service.start(context);
        const failures: unknown[] = [];
        for (const cleanup of cleanupOwner === "stop"
          ? [() => stop(context)]
          : disposals.toReversed()) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
        const failure = failures.length === 1 ? failures[0] : new AggregateError(failures);
        const leaves = (error: unknown): unknown[] =>
          error instanceof AggregateError ? error.errors.flatMap(leaves) : [error];
        if (cleanupFails) {
          expect(leaves(failure)).toEqual([activationFailure, cleanupFailure]);
        } else {
          expect(failure).toBe(activationFailure);
        }
        expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(2);
        expect(
          cleanupOwner === "stop" ? closeAllMemorySearchManagersMock : drain,
        ).toHaveBeenCalledOnce();
      } finally {
        lifecycle.prepare = previousPrepare;
        lifecycle.reload = previousReload;
        closeAllMemorySearchManagersMock.mockReset();
      }
    },
  );

  it("wires scoped memory search cleanup through the lazy runtime", async () => {
    const { runtime } = captureCapability();
    const cfg = {} as OpenClawConfig;

    await runtime.closeMemorySearchManager?.({ cfg, agentId: "main" });

    expect(closeMemorySearchManagerMock).toHaveBeenCalledWith({ cfg, agentId: "main" });
  });

  it("defers nested host runtime access until the injected operation runs", async () => {
    const acquireLocalService = vi.fn(async () => undefined);
    const openKeyedStore = vi.fn(() => ({}));
    const llmGetter = vi.fn(() => ({ acquireLocalService }));
    const stateGetter = vi.fn(() => ({ openKeyedStore }));
    const host = Object.defineProperties(
      {},
      {
        llm: { configurable: true, enumerable: true, get: llmGetter },
        state: { configurable: true, enumerable: true, get: stateGetter },
      },
    ) as OpenClawPluginApi["runtime"];
    const { runtime } = captureCapability({ runtime: host });

    expect(llmGetter).not.toHaveBeenCalled();
    expect(stateGetter).not.toHaveBeenCalled();
    await runtime?.getMemorySearchManager({ cfg: {}, agentId: "main" });
    const injectedHost = createMemoryRuntimeMock.mock.calls.at(-1)?.[0];
    if (!injectedHost?.acquireLocalService || !injectedHost.openKeyedStore) {
      throw new Error("expected memory-core host operations");
    }

    const target = { providerId: "local", baseUrl: "http://127.0.0.1:11434" };
    await injectedHost.acquireLocalService(target);
    const storeOptions = { namespace: "lazy-host", maxEntries: 1 };
    injectedHost.openKeyedStore(storeOptions);

    expect(llmGetter).toHaveBeenCalledOnce();
    expect(acquireLocalService).toHaveBeenCalledWith(target);
    expect(stateGetter).toHaveBeenCalledOnce();
    expect(openKeyedStore).toHaveBeenCalledWith(storeOptions);
  });

  it("forwards search-hit authorization through the registered memory runtime", async () => {
    const { runtime } = captureCapability();
    const hits = [
      {
        source: "sessions" as const,
        path: "sessions/private.jsonl",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "private",
      },
    ];

    const params = {
      cfg: {},
      agentId: "main",
      requesterSessionKey: "agent:main:voice:15550001234",
      sandboxed: false,
      hits,
    };
    await expect(runtime.authorizeSearchHits?.(params)).resolves.toEqual(hits);
    expect(authorizeSearchHitsMock).toHaveBeenCalledWith(params);
    expect(createMemoryRuntimeMock).toHaveBeenCalledWith({
      acquireLocalService: expect.any(Function),
      openKeyedStore: expect.any(Function),
    });
  });
});

describe("buildMemoryFlushPlan", () => {
  const cfg: OpenClawConfig = {
    agents: { defaults: { userTimezone: "America/New_York" } },
  };
  const configuredFlush = (
    memoryFlush: NonNullable<
      NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["compaction"]
    >["memoryFlush"],
  ) => buildMemoryFlushPlan({ cfg: { agents: { defaults: { compaction: { memoryFlush } } } } });

  it("replaces YYYY-MM-DD using user timezone and appends current time", () => {
    const plan = buildMemoryFlushPlan({
      cfg,
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(plan?.prompt).toContain("memory/2026-02-16.md");
    expect(plan?.prompt).toContain(
      "Current time: Monday, February 16th, 2026 - 10:00 AM (America/New_York)",
    );
    expect(plan?.prompt).toContain("Reference UTC: 2026-02-16 15:00 UTC");
    expect(plan?.relativePath).toBe("memory/2026-02-16.md");
    expect((plan?.prompt.match(/Current time:/g) ?? []).length).toBe(1);
  });

  it("defaults to safe prompts and gating values", () => {
    const plan = buildMemoryFlushPlan();
    expect(plan).toMatchObject({
      softThresholdTokens: 4000,
      forceFlushTranscriptBytes: 2 * 1024 * 1024,
    });
    expect(plan?.prompt).toContain("memory/");
    expect(plan?.prompt).toContain("MEMORY.md");
    expect(plan?.systemPrompt).toContain("MEMORY.md");
    expect(plan?.prompt).toMatch(/APPEND/i);
    expect(plan?.prompt).toContain("do not overwrite");
    expect(plan?.prompt).toContain("timestamped variant");
    expect(plan?.prompt).toMatch(/memory\/\d{4}-\d{2}-\d{2}\.md/);
  });

  it("respects disable flag", () => {
    expect(configuredFlush({ enabled: false })).toBeNull();
  });

  it.each([
    [
      { softThresholdTokens: -100 },
      { softThresholdTokens: 4000, forceFlushTranscriptBytes: 2 * 1024 * 1024 },
    ],
    [{ forceFlushTranscriptBytes: "3mb" }, { forceFlushTranscriptBytes: 3 * 1024 * 1024 }],
  ])("resolves memory flush override %j", (config, expected) => {
    expect(configuredFlush(config)).toMatchObject(expected);
  });
});
