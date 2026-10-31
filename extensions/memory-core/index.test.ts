import assert from "node:assert/strict";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMemoryFlushPlan } from "./src/flush-plan.js";
import { buildMemoryPromptSection } from "./src/memory-tool-contract.js";
import { getMemoryManagerLifecycle, markMemoryIndexingLive } from "./src/memory/lifecycle.js";
import type { MemoryCoreRuntimeHost } from "./src/memory/runtime-host.js";

const closeAllMemorySearchManagersMock = vi.hoisted(() => vi.fn(async () => {}));
const getMemorySearchManagerMock = vi.hoisted(() => vi.fn(async () => ({ manager: null })));
const authorizeSearchHitsMock = vi.hoisted(() => vi.fn(async ({ hits }) => hits));
const createMemoryRuntimeMock = vi.hoisted(() =>
  vi.fn((_host: MemoryCoreRuntimeHost = {}) => ({
    authorizeSearchHits: authorizeSearchHitsMock,
    closeAllMemorySearchManagers: closeAllMemorySearchManagersMock,
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
    openKeyedStore: vi.fn(() => {
      throw new Error("Registration must not open a state store");
    }),
  },
} as unknown as OpenClawPluginApi["runtime"];

function hostRuntimeWithConfig(current: () => OpenClawConfig) {
  return createPluginRuntimeMock({
    ...hostRuntime,
    config: { ...hostRuntime.config, current },
  });
}

type ApiOptions = Parameters<typeof createTestPluginApi>[0];

function captureCapability(
  overrides: ApiOptions = {},
  configure?: (api: OpenClawPluginApi) => void,
) {
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  const registerMemoryCapability = vi.fn<OpenClawPluginApi["registerMemoryCapability"]>();
  const services: OpenClawPluginService[] = [];
  const backgroundTasks: unknown[] = [];
  const disposals: Array<() => void | Promise<void>> = [];
  const api = createTestPluginApi({
    id: "memory-core",
    runtime: hostRuntime,
    registerTool,
    registerService(service) {
      if (service.id === "memory-core-index") {
        assert(service.apiVersion !== 2, "Unexpected scheduled service");
        services.push(service);
      }
    },
    ...overrides,
    registerMemoryCapability,
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
  const captured = registerMemoryCapability.mock.calls[0]?.[0];
  assert(captured?.promptBuilder && captured.runtime, "Expected memory capability");
  return {
    promptBuilder: captured.promptBuilder,
    runtime: captured.runtime,
    tools: registerTool.mock.calls,
    services,
    backgroundTasks,
    disposals,
    context: { config: api.config, stateDir: "unused", logger: api.logger },
  };
}

function captureMemoryModelContract(initialConfig: OpenClawConfig) {
  const { promptBuilder, tools } = captureCapability({
    config: initialConfig,
    runtime: hostRuntimeWithConfig(() => initialConfig),
  });
  const create = (name: string) => {
    const factory = tools.find(([, options]) => options?.names?.includes(name))?.[0];
    assert(typeof factory === "function", `Missing tool factory: ${name}`);
    const tool = factory({
      agentId: "main",
      config: initialConfig,
      getRuntimeConfig: () => initialConfig,
    });
    assert(tool && !Array.isArray(tool), `Expected one tool: ${name}`);
    return tool;
  };
  return { search: create("memory_search"), get: create("memory_get"), promptBuilder };
}

function indexConfig(memory?: string): OpenClawConfig {
  return {
    agents: { entries: { main: {}, research: {} } },
    ...(memory ? { plugins: { slots: { memory } } } : {}),
  };
}

describe("buildPromptSection", () => {
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

  it.each([true, false])(
    "adds only safe project write guidance with search enabled=%s",
    (enabled) => {
      const config: OpenClawConfig = {
        agents: { entries: { main: {} } },
        memory: { search: { enabled } },
      };
      const { promptBuilder } = captureCapability({
        config,
        runtime: hostRuntimeWithConfig(() => config),
      });
      const prompt = (projectKey?: string) =>
        promptBuilder({
          availableTools: new Set(["memory_search", "memory_get"]),
          agentId: "main",
          projectKey,
        }).join("\n");

      expect(prompt("github.com/OpenClaw/OpenClaw")).toContain(
        "<!-- project: github.com/OpenClaw/OpenClaw -->",
      );
      for (const projectKey of [undefined, "path:/tmp/unsafe-->note", "path:/tmp/a\nb"]) {
        expect(prompt(projectKey)).not.toContain("<!-- project:");
      }
    },
  );

  it.each([
    [["memory_search", "memory_get"], undefined],
    [["memory_search"], undefined],
    [["memory_get"], undefined],
    [["memory_search"], "off"],
  ] as const)("guides recall using %j with citations=%s", (tools, citationsMode) => {
    const result = buildMemoryPromptSection({ availableTools: new Set(tools), citationsMode });
    expect(result[1]).toContain(`run ${tools[0]}`);
    expect(result[1]).toContain("not already present in the current turn");
    expect(result[1]).toContain("Do not repeat memory retrieval");
    expect(result[1]?.includes("for memory-file hits, use memory_get")).toBe(tools.length === 2);
    if (tools[0] === "memory_get") {
      expect(result[1]).not.toContain("run memory_search");
    }
    expect(result).toContain(
      citationsMode === "off"
        ? "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks."
        : "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
    expect(result.at(-1)).toBe("");
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

  it.each([
    { label: "base files", extraPaths: [], sessions: false },
    { label: "configured extra paths", extraPaths: ["notes"], sessions: false },
    { label: "session transcripts", extraPaths: [], sessions: true },
  ])("describes the configured memory sources for $label", (sourceCase) => {
    const search = {
      sources: sourceCase.sessions ? ["memory", "sessions"] : ["memory"],
      ...(sourceCase.sessions ? { experimental: { sessionMemory: true } } : {}),
    };
    const config = {
      agents: { entries: { main: { memory: { search } } } },
      memory: { search: { provider: "none", extraPaths: sourceCase.extraPaths } },
    } as OpenClawConfig;
    const lazy = captureMemoryModelContract(config);
    for (const text of [lazy.search.description, lazy.get.description]) {
      expect(text).toContain("MEMORY.md, USER.md");
      expect(text).toContain("recursively under memory/");
      expect(text).toContain("results are partial");
      expect(text.includes("configured extra paths")).toBe(sourceCase.extraPaths.length > 0);
    }
    const defaultSearchScope = lazy.search.description.split(". ", 1)[0] ?? "";
    expect(defaultSearchScope.includes("indexed session transcripts")).toBe(sourceCase.sessions);
    expect(lazy.get.description).not.toContain("indexed session transcripts");
    expect(lazy.search.description).toContain("Corpus outcomes cover each requested corpus");
    expect(lazy.get.description).toContain("status=ok");
    expect(lazy.get.description).toContain("status=not_found");
  });
});

describe("memory-core plugin runtime registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    const registerCommand = vi.fn<OpenClawPluginApi["registerCommand"]>();
    captureCapability({ registerCommand });
    expect(registerCommand.mock.calls[0]?.[0]).toMatchObject({
      name: "dreaming",
      acceptsArgs: true,
      exposeSenderIsOwner: true,
      description: expect.stringContaining("Enable or disable"),
    });
  });

  it("scopes the dreaming reply hook to scheduled turns across three registrations", () => {
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const on = vi.fn();
      const subagentRun = vi.fn();
      captureCapability({
        on,
        runtime: { ...hostRuntime, subagent: { run: subagentRun } } as never,
      });
      expect(
        on.mock.calls
          .filter(([name]) => name === "before_agent_reply")
          .map((call) => call[2]?.eligibleTriggers),
        `cycle ${cycle}`,
      ).toEqual([["heartbeat", "cron"]]);
      expect(on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
      expect(subagentRun).not.toHaveBeenCalled();
    }
  });

  it("keeps intent definitions stable and prepares integer arguments for validation", () => {
    const warn = vi.fn();
    const { tools } = captureCapability({
      config: {},
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn },
    });
    const factory = tools.find(([, options]) => options?.names?.includes("intent"))?.[0];
    assert(factory && "contextVersion" in factory, "Expected v2 intent factory");
    expect(factory.contextVersion).toBe(2);
    const intentFactory = (ctx: { config?: OpenClawConfig }) =>
      factory.create({ ...ctx, assertInvocationCurrent: () => {} });

    expect(intentFactory({})).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("runtime config is unavailable"));

    const ownerTool = intentFactory({ config: {} }) as AnyAgentTool;
    expect(ownerTool).toMatchObject({ name: "intent" });
    const next = intentFactory({ config: {} }) as AnyAgentTool;
    expect(next.description).toBe(ownerTool.description);
    expect(next.parameters).toBe(ownerTool.parameters);
    expect(next.execute).not.toBe(ownerTool.execute);
    const prepared = ownerTool.prepareArguments?.({
      action: "create",
      maxFires: "3",
      cooldownSeconds: "0",
    });
    expect(prepared).toEqual({ action: "create", maxFires: 3, cooldownSeconds: 0 });
    expect(Value.Check(ownerTool.parameters, prepared)).toBe(true);
    expect(() => ownerTool.prepareArguments?.({ action: "create", maxFires: "0" })).toThrow(
      "maxFires must be a positive integer",
    );
    expect(ownerTool.description).toContain("system injects the reminder automatically");
    expect(ownerTool.description).toContain("Use scheduled tasks for time-based reminders");
    expect(ownerTool.description).not.toMatch(/\b(?:cron|automations)\b/u);
    expect(ownerTool.parameters).not.toHaveProperty("properties.channelScope");
    expect(ownerTool.parameters).toMatchObject({
      properties: {
        scope: { default: "channel" },
        senderScope: { default: "sender" },
      },
    });
  });

  // Runs before any case below marks process-wide indexing live.
  it("leaves cold-start indexing demand-driven until a manager has run", async () => {
    const config = indexConfig("memory-core");
    const {
      services: [service],
      backgroundTasks,
      context,
    } = captureCapability({ config });
    assert(service, "Expected the memory index service");
    await service.start(context);
    expect(backgroundTasks).toEqual([]);
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();

    // A watched manager opened by a search or turn makes later restarts restore it.
    markMemoryIndexingLive("main");
    markMemoryIndexingLive("research");
    await service.stop?.(context);
    await service.start(context);
    await Promise.all(backgroundTasks);
    expect(getMemorySearchManagerMock.mock.calls).toEqual([
      [{ cfg: config, agentId: "main" }],
      [{ cfg: config, agentId: "research" }],
    ]);
  });

  it.each(["honcho", "none"])(
    "starts configured indexes only for the selected memory slot: %s",
    async (owner) => {
      markMemoryIndexingLive("main");
      markMemoryIndexingLive("research");
      const config = indexConfig(owner);
      const { services, backgroundTasks, context } = captureCapability({ config });
      for (const service of services) {
        await service.start(context);
      }
      await Promise.all(backgroundTasks);
      expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
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
        } = captureCapability({ config }, (api) => {
          api.lifecycle.runInBackgroundContext = runInBackgroundContext;
        });
        assert(service?.stop && disposals.length, "Expected memory index cleanup owners");
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
    expect(llmGetter).not.toHaveBeenCalled();
    expect(stateGetter).not.toHaveBeenCalled();
    const injectedHost = createMemoryRuntimeMock.mock.calls.at(-1)?.[0];
    if (!injectedHost?.acquireLocalService || !injectedHost.openKeyedStore) {
      throw new Error("expected memory-core host operations");
    }

    const target: Parameters<OpenClawPluginApi["runtime"]["llm"]["acquireLocalService"]>[0] = {
      providerId: "local",
      baseUrl: "http://127.0.0.1:11434",
      onReadinessWait: vi.fn(),
    };
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
