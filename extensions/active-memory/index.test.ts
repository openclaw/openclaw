import fs from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import plugin from "./index.js";

const hoisted = vi.hoisted(() => {
  const sessionStore: Record<string, Record<string, unknown>> = {
    "agent:main:main": {
      sessionId: "s-main",
      updatedAt: 0,
    },
  };
  return {
    sessionStore,
    updateSessionStore: vi.fn(
      async (_storePath: string, updater: (store: Record<string, unknown>) => void) => {
        updater(sessionStore);
      },
    ),
  };
});

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
  return {
    ...actual,
    updateSessionStore: hoisted.updateSessionStore,
  };
});

describe("active-memory plugin", () => {
  const hooks: Record<string, Function> = {};
  const runEmbeddedPiAgent = vi.fn();
  const api: any = {
    pluginConfig: {
      agents: ["main"],
      logging: true,
    },
    config: {},
    id: "active-memory",
    name: "Active Memory",
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    runtime: {
      agent: {
        runEmbeddedPiAgent,
        session: {
          resolveStorePath: vi.fn(() => "/tmp/openclaw-session-store.json"),
          loadSessionStore: vi.fn(() => hoisted.sessionStore),
          saveSessionStore: vi.fn(async () => {}),
        },
      },
    },
    on: vi.fn((hookName: string, handler: Function) => {
      hooks[hookName] = handler;
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.sessionStore["agent:main:main"] = {
      sessionId: "s-main",
      updatedAt: 0,
    };
    for (const key of Object.keys(hooks)) {
      delete hooks[key];
    }
    runEmbeddedPiAgent.mockResolvedValue({
      payloads: [{ text: "- lemon pepper wings\n- blue cheese" }],
    });
    plugin.register(api as unknown as OpenClawPluginApi);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a before_prompt_build hook", () => {
    expect(api.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
  });

  it("does not run for agents that are not explicitly targeted", async () => {
    const result = await hooks.before_prompt_build(
      { prompt: "what wings should i order?", messages: [] },
      {
        agentId: "support",
        trigger: "user",
        sessionKey: "agent:support:main",
        messageProvider: "webchat",
      },
    );

    expect(result).toBeUndefined();
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("does not rewrite session state for skipped turns with no active-memory entry to clear", async () => {
    const result = await hooks.before_prompt_build(
      { prompt: "what wings should i order?", messages: [] },
      {
        agentId: "support",
        trigger: "user",
        sessionKey: "agent:support:main",
        messageProvider: "webchat",
      },
    );

    expect(result).toBeUndefined();
    expect(hoisted.updateSessionStore).not.toHaveBeenCalled();
  });

  it("does not run for non-interactive contexts", async () => {
    const result = await hooks.before_prompt_build(
      { prompt: "what wings should i order?", messages: [] },
      {
        agentId: "main",
        trigger: "heartbeat",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    expect(result).toBeUndefined();
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("injects system context on a successful recall hit", async () => {
    const result = await hooks.before_prompt_build(
      {
        prompt: "what wings should i order?",
        messages: [
          { role: "user", content: "i want something greasy tonight" },
          { role: "assistant", content: "let's narrow it down" },
        ],
      },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      appendSystemContext: expect.stringContaining("<active_memory>"),
    });
    expect((result as { appendSystemContext: string }).appendSystemContext).toContain(
      "lemon pepper wings",
    );
    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]).toMatchObject({
      provider: "github-copilot",
      model: "gpt-5.4-mini",
    });
  });

  it("falls back to the current session model when no plugin model is configured", async () => {
    api.pluginConfig = {
      agents: ["main"],
    };
    plugin.register(api as unknown as OpenClawPluginApi);

    await hooks.before_prompt_build(
      { prompt: "what wings should i order? temp transcript", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
        modelProviderId: "qwen",
        modelId: "glm-5",
      },
    );

    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]).toMatchObject({
      provider: "qwen",
      model: "glm-5",
    });
  });

  it("persists a readable debug summary alongside the status line", async () => {
    const sessionKey = "agent:main:debug";
    hoisted.sessionStore[sessionKey] = {
      sessionId: "s-main",
      updatedAt: 0,
    };

    await hooks.before_prompt_build(
      {
        prompt: "what wings should i order?",
        messages: [],
      },
      { agentId: "main", trigger: "user", sessionKey, messageProvider: "webchat" },
    );

    expect(hoisted.updateSessionStore).toHaveBeenCalled();
    const updater = hoisted.updateSessionStore.mock.calls.at(-1)?.[1] as
      | ((store: Record<string, Record<string, unknown>>) => void)
      | undefined;
    const store = {
      [sessionKey]: {
        sessionId: "s-main",
        updatedAt: 0,
      },
    } as Record<string, Record<string, unknown>>;
    updater?.(store);
    expect(store[sessionKey]?.pluginDebugEntries).toEqual([
      {
        pluginId: "active-memory",
        lines: expect.arrayContaining([
          expect.stringContaining("🧩 Active Memory: ok"),
          expect.stringContaining("🔎 Active Memory Debug: lemon pepper wings"),
        ]),
      },
    ]);
  });

  it("returns nothing when the sidecar says none", async () => {
    runEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [{ text: "NONE" }],
    });

    const result = await hooks.before_prompt_build(
      { prompt: "fair, okay gonna do them by throwing them in the garbage", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    expect(result).toBeUndefined();
  });

  it("does not cache timeout results", async () => {
    api.pluginConfig = {
      agents: ["main"],
      timeoutMs: 250,
      logging: true,
    };
    plugin.register(api as unknown as OpenClawPluginApi);
    runEmbeddedPiAgent.mockImplementation(
      async () => await new Promise((resolve) => setTimeout(() => resolve({ payloads: [] }), 300)),
    );

    await hooks.before_prompt_build(
      { prompt: "what wings should i order? timeout test", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:timeout-test",
        messageProvider: "webchat",
      },
    );
    await hooks.before_prompt_build(
      { prompt: "what wings should i order? timeout test", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:timeout-test",
        messageProvider: "webchat",
      },
    );

    expect(hoisted.updateSessionStore).toHaveBeenCalledTimes(2);
    const infoLines = vi
      .mocked(api.logger.info)
      .mock.calls.map((call: unknown[]) => String(call[0]));
    expect(infoLines.some((line: string) => line.includes(" cached "))).toBe(false);
  });

  it("clears stale status on skipped non-interactive turns even when agentId is missing", async () => {
    const sessionKey = "agent:main:missing-agent";
    hoisted.sessionStore[sessionKey] = {
      sessionId: "s-main",
      updatedAt: 0,
      pluginDebugEntries: [
        { pluginId: "active-memory", lines: ["🧩 Active Memory: timeout 15s recent"] },
      ],
    };

    const result = await hooks.before_prompt_build(
      { prompt: "what wings should i order?", messages: [] },
      { trigger: "heartbeat", sessionKey, messageProvider: "webchat" },
    );

    expect(result).toBeUndefined();
    const updater = hoisted.updateSessionStore.mock.calls.at(-1)?.[1] as
      | ((store: Record<string, Record<string, unknown>>) => void)
      | undefined;
    const store = {
      [sessionKey]: {
        sessionId: "s-main",
        updatedAt: 0,
        pluginDebugEntries: [
          { pluginId: "active-memory", lines: ["🧩 Active Memory: timeout 15s recent"] },
        ],
      },
    } as Record<string, Record<string, unknown>>;
    updater?.(store);
    expect(store[sessionKey]?.pluginDebugEntries).toBeUndefined();
  });

  it("supports message mode by sending only the latest user message", async () => {
    api.pluginConfig = {
      agents: ["main"],
      queryMode: "message",
    };
    plugin.register(api as unknown as OpenClawPluginApi);

    await hooks.before_prompt_build(
      {
        prompt: "what should i grab on the way?",
        messages: [
          { role: "user", content: "i have a flight tomorrow" },
          { role: "assistant", content: "got it" },
        ],
      },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    const prompt = runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.prompt;
    expect(prompt).toContain("Conversation context:\nwhat should i grab on the way?");
    expect(prompt).not.toContain("Recent conversation tail:");
  });

  it("supports full mode by sending the whole conversation", async () => {
    api.pluginConfig = {
      agents: ["main"],
      queryMode: "full",
    };
    plugin.register(api as unknown as OpenClawPluginApi);

    await hooks.before_prompt_build(
      {
        prompt: "what should i grab on the way?",
        messages: [
          { role: "user", content: "i have a flight tomorrow" },
          { role: "assistant", content: "got it" },
          { role: "user", content: "packing is annoying" },
        ],
      },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    const prompt = runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.prompt;
    expect(prompt).toContain("Full conversation context:");
    expect(prompt).toContain("user: i have a flight tomorrow");
    expect(prompt).toContain("assistant: got it");
    expect(prompt).toContain("user: packing is annoying");
  });

  it("loosens zero-overlap filtering for preference-seeking turns when concrete relevance is disabled", async () => {
    api.pluginConfig = {
      agents: ["main"],
      requireConcreteRelevance: false,
      dropGenericPreferencesOnNonPreferenceTurns: false,
    };
    plugin.register(api as unknown as OpenClawPluginApi);
    runEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [{ text: "- spicy ramen with a soft-boiled egg" }],
    });

    const result = await hooks.before_prompt_build(
      { prompt: "what should i order?", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    expect(result).toEqual({
      appendSystemContext: expect.stringContaining("spicy ramen with a soft-boiled egg"),
    });
  });

  it("keeps sidecar transcripts off disk by default by using a temp session file", async () => {
    const mkdtempSpy = vi
      .spyOn(fs, "mkdtemp")
      .mockResolvedValue("/tmp/openclaw-active-memory-temp");
    const rmSpy = vi.spyOn(fs, "rm").mockResolvedValue(undefined);

    await hooks.before_prompt_build(
      { prompt: "what wings should i order?", messages: [] },
      {
        agentId: "main",
        trigger: "user",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      },
    );

    expect(mkdtempSpy).toHaveBeenCalled();
    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.sessionFile).toBe(
      "/tmp/openclaw-active-memory-temp/session.jsonl",
    );
    expect(rmSpy).toHaveBeenCalledWith("/tmp/openclaw-active-memory-temp", {
      recursive: true,
      force: true,
    });
  });

  it("persists sidecar transcripts in a separate directory when enabled", async () => {
    api.pluginConfig = {
      agents: ["main"],
      persistTranscripts: true,
      transcriptDir: "active-memory-sidecars",
      logging: true,
    };
    plugin.register(api as unknown as OpenClawPluginApi);
    const mkdirSpy = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const mkdtempSpy = vi.spyOn(fs, "mkdtemp");
    const rmSpy = vi.spyOn(fs, "rm").mockResolvedValue(undefined);

    const sessionKey = "agent:main:persist-transcript";
    await hooks.before_prompt_build(
      { prompt: "what wings should i order? persist transcript", messages: [] },
      { agentId: "main", trigger: "user", sessionKey, messageProvider: "webchat" },
    );

    expect(mkdirSpy).toHaveBeenCalledWith("/tmp/active-memory-sidecars", { recursive: true });
    expect(mkdtempSpy).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgent.mock.calls.at(-1)?.[0]?.sessionFile).toMatch(
      /^\/tmp\/active-memory-sidecars\/active-memory-[a-z0-9]+\.jsonl$/,
    );
    expect(rmSpy).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(api.logger.info)
        .mock.calls.some((call: unknown[]) =>
          String(call[0]).includes("transcript=/tmp/active-memory-sidecars/"),
        ),
    ).toBe(true);
  });
});
