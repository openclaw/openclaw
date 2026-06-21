// Codex tests cover media understanding provider plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCodexMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./src/app-server/client.js";
import type { CodexServerNotification, JsonValue } from "./src/app-server/protocol.js";
import { adaptCodexTestClientFactory } from "./src/app-server/test-support.js";

const EXPECTED_MEDIA_THREAD_CONFIG = {
  project_doc_max_bytes: 0,
  web_search: "disabled",
  "tools.experimental_request_user_input.enabled": false,
  "features.hooks": false,
  "features.multi_agent": false,
  "features.apps": false,
  "features.plugins": false,
  "features.image_generation": false,
  "features.skill_mcp_dependency_install": false,
  "features.memories": false,
  "features.goals": false,
  "features.code_mode": false,
  "features.code_mode_only": false,
};

const sharedClientMocks = vi.hoisted(() => ({
  createIsolatedCodexAppServerClient: vi.fn(),
}));

vi.mock("./src/app-server/shared-client.js", () => ({
  createIsolatedCodexAppServerClient: sharedClientMocks.createIsolatedCodexAppServerClient,
}));

function codexModel(inputModalities: string[] = ["text", "image"]) {
  return {
    id: "gpt-5.4",
    model: "gpt-5.4",
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "gpt-5.4",
    description: "GPT-5.4",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "fast" }],
    defaultReasoningEffort: "low",
    inputModalities,
    supportsPersonality: false,
    additionalSpeedTiers: [],
    isDefault: true,
  };
}

function threadStartResult() {
  return {
    thread: {
      id: "thread-1",
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: true,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: "/tmp/openclaw-agent",
      cliVersion: "0.125.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/tmp/openclaw-agent",
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

function turnStartResult(status = "inProgress", items: JsonValue[] = []) {
  return {
    turn: {
      id: "turn-1",
      status,
      items,
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

function createFakeClient(options?: {
  inputModalities?: string[];
  completeWithItems?: boolean;
  notifyError?: string;
  responseText?: string;
  turnStartError?: Error;
  preBindNotificationCount?: number;
  interruptError?: Error;
  unsubscribeError?: Error;
}) {
  const notifications = new Set<(notification: CodexServerNotification) => void>();
  const closeHandlers = new Set<() => void>();
  const requests: Array<{ method: string; params?: JsonValue }> = [];
  const request = vi.fn(async (method: string, params?: JsonValue) => {
    requests.push({ method, params });
    if (method === "model/list") {
      return {
        data: [codexModel(options?.inputModalities)],
        nextCursor: null,
      };
    }
    if (method === "thread/start") {
      return threadStartResult();
    }
    if (method === "turn/start") {
      if (options?.turnStartError) {
        throw options.turnStartError;
      }
      if (options?.preBindNotificationCount) {
        for (let index = 0; index < options.preBindNotificationCount; index += 1) {
          for (const notify of notifications) {
            notify({
              method: "item/started",
              params: { threadId: "thread-1", turnId: "turn-1" },
            });
          }
        }
        return turnStartResult();
      }
      const emitTurnNotifications = () => {
        if (options?.notifyError) {
          for (const notify of notifications) {
            notify({
              method: "error",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                error: {
                  message: options.notifyError,
                  codexErrorInfo: null,
                  additionalDetails: null,
                },
                willRetry: false,
              },
            });
          }
        } else if (!options?.completeWithItems) {
          for (const notify of notifications) {
            notify({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "msg-1",
                delta: options?.responseText ?? "A red square.",
              },
            });
            notify({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                turn: turnStartResult("completed").turn,
              },
            });
          }
        }
      };
      emitTurnNotifications();
      return turnStartResult(
        options?.completeWithItems ? "completed" : "inProgress",
        options?.completeWithItems
          ? [
              {
                id: "msg-1",
                type: "agentMessage",
                text: options?.responseText ?? "A blue circle.",
                phase: null,
                memoryCitation: null,
              },
            ]
          : [],
      );
    }
    if (method === "turn/interrupt" && options?.interruptError) {
      throw options.interruptError;
    }
    if (method === "thread/unsubscribe" && options?.unsubscribeError) {
      throw options.unsubscribeError;
    }
    return {};
  });

  const client = {
    request,
    addNotificationHandler(handler: (notification: CodexServerNotification) => void) {
      notifications.add(handler);
      return () => notifications.delete(handler);
    },
    addRequestHandler() {
      return () => undefined;
    },
    addCloseHandler(handler: () => void) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close: vi.fn(),
  } as unknown as CodexAppServerClient;

  return { client, requests };
}

describe("codex media understanding provider", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sharedClientMocks.createIsolatedCodexAppServerClient.mockReset();
  });

  it("runs image understanding through a bounded Codex app-server turn", async () => {
    const { client, requests } = createFakeClient();
    const clientFactory = vi.fn(async () => client);
    const provider = buildCodexMediaUnderstandingProvider({
      clientLeaseFactory: adaptCodexTestClientFactory(clientFactory),
    });
    const cfg = {
      auth: {
        order: {
          openai: ["openai:work"],
        },
      },
    };

    const result = await provider.describeImage?.({
      buffer: Buffer.from("image-bytes"),
      fileName: "image.png",
      mime: "image/png",
      provider: "codex",
      model: "gpt-5.4",
      prompt: "Describe briefly.",
      timeoutMs: 30_000,
      cfg,
      agentDir: "/tmp/openclaw-agent",
    });

    expect(result).toEqual({ text: "A red square.", model: "gpt-5.4" });
    expect(clientFactory).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
      "/tmp/openclaw-agent",
      cfg,
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
    expect(requests.map((entry) => entry.method)).toEqual([
      "model/list",
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
    ]);
    expect(requests[0]?.params).toEqual({ limit: 100, cursor: null, includeHidden: true });
    expect(requests[1]?.params).toEqual({
      model: "gpt-5.4",
      modelProvider: "openai",
      cwd: "/tmp/openclaw-agent/codex-media-home",
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "OpenClaw",
      personality: "none",
      developerInstructions:
        "You are OpenClaw's bounded image-understanding worker. Describe only the provided image content. Do not call tools, edit files, or ask follow-up questions.",
      config: EXPECTED_MEDIA_THREAD_CONFIG,
      environments: [],
      ephemeral: true,
    });
    expect(requests[2]?.params).toEqual({
      threadId: "thread-1",
      input: [
        { type: "text", text: "Describe briefly.", text_elements: [] },
        { type: "image", url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=" },
      ],
      effort: "low",
    });
  });

  it("treats a blank agent directory as absent when starting the app-server", async () => {
    const { client, requests } = createFakeClient();
    const clientFactory = vi.fn(async () => client);
    const provider = buildCodexMediaUnderstandingProvider({
      clientLeaseFactory: adaptCodexTestClientFactory(clientFactory),
    });
    const cfg = {
      agents: { list: [{ id: "main", agentDir: "/tmp/openclaw-default-agent" }] },
    };

    await provider.describeImage?.({
      buffer: Buffer.from("image-bytes"),
      fileName: "image.png",
      mime: "image/png",
      provider: "codex",
      model: "gpt-5.4",
      timeoutMs: 30_000,
      cfg,
      agentDir: " ",
    });

    expect(clientFactory).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
      "/tmp/openclaw-default-agent",
      cfg,
      expect.any(Object),
    );
    expect(requests[1]?.params).toEqual(
      expect.objectContaining({ cwd: "/tmp/openclaw-default-agent/codex-media-home" }),
    );
  });

  it("preserves configured WebSocket transport for media turns", async () => {
    const { client, requests } = createFakeClient();
    const clientFactory = vi.fn(async () => client);
    const provider = buildCodexMediaUnderstandingProvider({
      pluginConfig: {
        appServer: {
          transport: "websocket",
          url: "ws://127.0.0.1:4501",
        },
      },
      clientFactory,
    });

    await provider.describeImage?.({
      buffer: Buffer.from("image-bytes"),
      fileName: "image.png",
      mime: "image/png",
      provider: "codex",
      model: "gpt-5.4",
      timeoutMs: 30_000,
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
    });

    expect(clientFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: "websocket",
        url: "ws://127.0.0.1:4501",
      }),
      undefined,
      "/tmp/openclaw-agent",
      {},
      { timeoutMs: 30_000 },
    );
    expect(requests[1]?.params).toEqual(expect.objectContaining({ cwd: "/tmp/openclaw-agent" }));
    expect(requests[2]?.params).toEqual(expect.objectContaining({ cwd: "/tmp/openclaw-agent" }));
  });

  it("passes the scoped auth store into isolated app-server startup", async () => {
    const { client } = createFakeClient();
    sharedClientMocks.createIsolatedCodexAppServerClient.mockResolvedValue(client);
    const provider = buildCodexMediaUnderstandingProvider();
    const authStore = {
      version: 1,
      profiles: {
        "openai:scoped": {
          type: "oauth" as const,
          provider: "openai",
          access: "scoped-access",
          refresh: "scoped-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };

    await provider.describeImage?.({
      buffer: Buffer.from("image-bytes"),
      fileName: "image.png",
      mime: "image/png",
      provider: "codex",
      model: "gpt-5.4",
      timeoutMs: 30_000,
      cfg: {},
      authStore,
      agentDir: "/tmp/openclaw-agent",
    });

    expect(sharedClientMocks.createIsolatedCodexAppServerClient).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileStore: authStore }),
    );
  });

  it("clamps oversized image understanding turn timeouts", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const { client } = createFakeClient();
      const provider = buildCodexMediaUnderstandingProvider({
        clientLeaseFactory: adaptCodexTestClientFactory(async () => client),
      });

      const result = await provider.describeImage?.({
        buffer: Buffer.from("image-bytes"),
        fileName: "image.png",
        mime: "image/png",
        provider: "codex",
        model: "gpt-5.4",
        timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
      });

      expect(result?.text).toBe("A red square.");
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      vi.restoreAllMocks();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("starts the media deadline before client acquisition", async () => {
    vi.useFakeTimers();
    const provider = buildCodexMediaUnderstandingProvider({
      clientLeaseFactory: adaptCodexTestClientFactory(
        async () => await new Promise<CodexAppServerClient>(() => {}),
      ),
    });
    const description = provider.describeImage?.({
      buffer: Buffer.from("image-bytes"),
      fileName: "image.png",
      mime: "image/png",
      provider: "codex",
      model: "gpt-5.4",
      timeoutMs: 100,
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
    });
    const rejected = expect(description).rejects.toThrow(
      "Codex app-server image understanding timed out",
    );

    await vi.advanceTimersByTimeAsync(100);

    await rejected;
  });

  it("retires a media client lease that resolves after its deadline", async () => {
    let resolveLease!: (lease: {
      client: CodexAppServerClient;
      release: () => void;
      abandon: () => Promise<void>;
    }) => void;
    const pendingLease = new Promise<{
      client: CodexAppServerClient;
      release: () => void;
      abandon: () => Promise<void>;
    }>((resolve) => {
      resolveLease = resolve;
    });
    const clientLeaseFactory = vi.fn(async () => await pendingLease);
    const provider = buildCodexMediaUnderstandingProvider({ clientLeaseFactory });
    const description = provider.describeImage?.({
      buffer: Buffer.from("image-bytes"),
      fileName: "image.png",
      mime: "image/png",
      provider: "codex",
      model: "gpt-5.4",
      timeoutMs: 5,
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
    });

    await expect(description).rejects.toThrow("Codex app-server image understanding timed out");
    const { client } = createFakeClient();
    const release = vi.fn();
    const abandon = vi.fn(async () => undefined);
    resolveLease({ client, release, abandon });
    await vi.waitFor(() => expect(abandon).toHaveBeenCalledOnce());

    expect(release).not.toHaveBeenCalled();
  });

  it("releases the bounded route between isolated media calls", async () => {
    const { client, requests } = createFakeClient();
    const provider = buildCodexMediaUnderstandingProvider({
      clientLeaseFactory: adaptCodexTestClientFactory(async () => client),
    });
    const request = {
      buffer: Buffer.from("image-bytes"),
      fileName: "image.png",
      mime: "image/png",
      provider: "codex",
      model: "gpt-5.4",
      timeoutMs: 30_000,
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
    };

    const first = await provider.describeImage?.(request);
    const second = await provider.describeImage?.(request);

    expect(first?.text).toBe("A red square.");
    expect(second?.text).toBe("A red square.");
    expect(requests.filter((entry) => entry.method === "model/list")).toHaveLength(2);
    expect(requests.filter((entry) => entry.method === "thread/start")).toHaveLength(2);
  });

  it("extracts text from terminal turn items", async () => {
    const { client } = createFakeClient({ completeWithItems: true });
    const provider = buildCodexMediaUnderstandingProvider({
      clientLeaseFactory: adaptCodexTestClientFactory(async () => client),
    });

    const result = await provider.describeImages?.({
      images: [{ buffer: Buffer.from("image-bytes"), fileName: "image.png", mime: "image/png" }],
      provider: "codex",
      model: "gpt-5.4",
      prompt: "Describe briefly.",
      timeoutMs: 30_000,
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
    });

    expect(result).toEqual({ text: "A blue circle.", model: "gpt-5.4" });
  });

  it("rejects text-only Codex app-server models before starting a turn", async () => {
    const { client, requests } = createFakeClient({ inputModalities: ["text"] });
    const provider = buildCodexMediaUnderstandingProvider({
      clientLeaseFactory: adaptCodexTestClientFactory(async () => client),
    });

    await expect(
      provider.describeImage?.({
        buffer: Buffer.from("image-bytes"),
        fileName: "image.png",
        mime: "image/png",
        provider: "codex",
        model: "gpt-5.4",
        timeoutMs: 30_000,
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
      }),
    ).rejects.toThrow("Codex app-server model does not support images: gpt-5.4");
    expect(requests.map((entry) => entry.method)).toEqual(["model/list"]);
  });

  it("surfaces Codex app-server turn errors", async () => {
    const { client } = createFakeClient({ notifyError: "vision unavailable" });
    const provider = buildCodexMediaUnderstandingProvider({
      clientLeaseFactory: adaptCodexTestClientFactory(async () => client),
    });

    await expect(
      provider.describeImage?.({
        buffer: Buffer.from("image-bytes"),
        fileName: "image.png",
        mime: "image/png",
        provider: "codex",
        model: "gpt-5.4",
        timeoutMs: 30_000,
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
      }),
    ).rejects.toThrow("vision unavailable");
  });

  it.each([
    {
      name: "structured rejection",
      error: new CodexAppServerRpcError({ message: "turn rejected" }, "turn/start"),
      abandonCount: 0,
    },
    {
      name: "ambiguous timeout",
      error: new Error("turn/start timed out"),
      abandonCount: 1,
    },
  ])("handles $name with exact media lease ownership", async ({ error, abandonCount }) => {
    const { client } = createFakeClient({ turnStartError: error });
    const release = vi.fn();
    const abandon = vi.fn(async () => undefined);
    const provider = buildCodexMediaUnderstandingProvider({
      clientLeaseFactory: async () => ({ client, release, abandon }),
    });

    await expect(
      provider.describeImage?.({
        buffer: Buffer.from("image-bytes"),
        fileName: "image.png",
        mime: "image/png",
        provider: "codex",
        model: "gpt-5.4",
        timeoutMs: 30_000,
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
      }),
    ).rejects.toBe(error);

    expect(abandon).toHaveBeenCalledTimes(abandonCount);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("retires the media client when thread cleanup is unconfirmed", async () => {
    const { client } = createFakeClient({ unsubscribeError: new Error("unsubscribe failed") });
    const release = vi.fn();
    const abandon = vi.fn(async () => undefined);
    const provider = buildCodexMediaUnderstandingProvider({
      clientLeaseFactory: async () => ({ client, release, abandon }),
    });

    await expect(
      provider.describeImage?.({
        buffer: Buffer.from("image-bytes"),
        fileName: "image.png",
        mime: "image/png",
        provider: "codex",
        model: "gpt-5.4",
        timeoutMs: 30_000,
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
      }),
    ).resolves.toEqual({ text: "A red square.", model: "gpt-5.4" });

    expect(abandon).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  it("retires the media client when an accepted turn cannot be interrupted", async () => {
    const { client, requests } = createFakeClient({
      preBindNotificationCount: 257,
      interruptError: new Error("interrupt timeout"),
    });
    const release = vi.fn();
    const abandon = vi.fn(async () => undefined);
    const provider = buildCodexMediaUnderstandingProvider({
      clientLeaseFactory: async () => ({ client, release, abandon }),
    });

    await expect(
      provider.describeImage?.({
        buffer: Buffer.from("image-bytes"),
        fileName: "image.png",
        mime: "image/png",
        provider: "codex",
        model: "gpt-5.4",
        timeoutMs: 30_000,
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
      }),
    ).rejects.toThrow("pre-bind notification buffer exceeded 256 entries");

    expect(requests.map((entry) => entry.method)).toEqual([
      "model/list",
      "thread/start",
      "turn/start",
      "turn/interrupt",
    ]);
    expect(abandon).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  it("runs structured extraction through the same bounded Codex app-server path", async () => {
    const { client, requests } = createFakeClient({
      responseText: '{"summary":"red square","tags":["shape"]}',
    });
    const provider = buildCodexMediaUnderstandingProvider({
      clientLeaseFactory: adaptCodexTestClientFactory(async () => client),
    });

    const result = await provider.extractStructured?.({
      input: [
        { type: "text", text: "Extract searchable evidence." },
        {
          type: "image",
          buffer: Buffer.from("image-bytes"),
          fileName: "image.png",
          mime: "image/png",
        },
      ],
      instructions: "Return a compact evidence object.",
      schemaName: "example.media",
      jsonSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["summary"],
      },
      provider: "codex",
      model: "gpt-5.4",
      timeoutMs: 30_000,
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
    });

    expect(result).toEqual({
      text: '{"summary":"red square","tags":["shape"]}',
      parsed: { summary: "red square", tags: ["shape"] },
      model: "gpt-5.4",
      provider: "codex",
      contentType: "json",
    });
    expect(requests.map((entry) => entry.method)).toEqual([
      "model/list",
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
    ]);
    expect(requests[1]?.params).toEqual({
      model: "gpt-5.4",
      modelProvider: "openai",
      cwd: "/tmp/openclaw-agent/codex-media-home",
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "OpenClaw",
      personality: "none",
      developerInstructions:
        "You are OpenClaw's bounded structured-extraction worker. Return only the requested extraction. Do not call tools, edit files, ask follow-up questions, or include secrets.",
      config: EXPECTED_MEDIA_THREAD_CONFIG,
      environments: [],
      ephemeral: true,
    });
    const turnParams = requests[2]?.params as
      | {
          threadId?: unknown;
          approvalPolicy?: unknown;
          model?: unknown;
          input?: Array<{ type?: unknown; text?: unknown; text_elements?: unknown; url?: unknown }>;
          cwd?: unknown;
          effort?: unknown;
        }
      | undefined;
    expect(turnParams?.threadId).toBe("thread-1");
    expect(turnParams?.approvalPolicy).toBeUndefined();
    expect(turnParams?.model).toBeUndefined();
    expect(turnParams?.cwd).toBeUndefined();
    expect(turnParams?.effort).toBe("low");
    expect(turnParams?.input).toHaveLength(3);
    expect(turnParams?.input?.[0]?.type).toBe("text");
    expect(turnParams?.input?.[0]?.text).toContain("Return valid JSON only");
    expect(turnParams?.input?.[0]?.text_elements).toStrictEqual([]);
    expect(turnParams?.input?.[1]).toStrictEqual({
      type: "text",
      text: "Extract searchable evidence.",
      text_elements: [],
    });
    expect(turnParams?.input?.[2]).toStrictEqual({
      type: "image",
      url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
    });
  });

  it("rejects text-only structured extraction before starting a turn", async () => {
    const { client, requests } = createFakeClient({
      inputModalities: ["text"],
      responseText: '{"summary":"only text"}',
    });
    const provider = buildCodexMediaUnderstandingProvider({
      clientLeaseFactory: adaptCodexTestClientFactory(async () => client),
    });

    await expect(
      provider.extractStructured?.({
        input: [{ type: "text", text: "The answer is only text." }],
        instructions: "Return summary JSON.",
        provider: "codex",
        model: "gpt-5.4",
        timeoutMs: 30_000,
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
      }),
    ).rejects.toThrow("Codex structured extraction requires at least one image input.");
    expect(requests).toEqual([]);
  });

  it("returns a controlled error when structured JSON parsing fails", async () => {
    const { client } = createFakeClient({ responseText: "not json" });
    const provider = buildCodexMediaUnderstandingProvider({
      clientLeaseFactory: adaptCodexTestClientFactory(async () => client),
    });

    await expect(
      provider.extractStructured?.({
        input: [
          { type: "text", text: "Extract JSON." },
          {
            type: "image",
            buffer: Buffer.from("image-bytes"),
            fileName: "image.png",
            mime: "image/png",
          },
        ],
        instructions: "Return summary JSON.",
        provider: "codex",
        model: "gpt-5.4",
        timeoutMs: 30_000,
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
      }),
    ).rejects.toThrow("Codex structured extraction returned invalid JSON.");
  });

  it("validates structured extraction JSON against the requested schema", async () => {
    const { client } = createFakeClient({
      responseText: '{"summary":123,"tags":["shape"]}',
    });
    const provider = buildCodexMediaUnderstandingProvider({
      clientLeaseFactory: adaptCodexTestClientFactory(async () => client),
    });

    await expect(
      provider.extractStructured?.({
        input: [
          { type: "text", text: "Extract JSON." },
          {
            type: "image",
            buffer: Buffer.from("image-bytes"),
            fileName: "image.png",
            mime: "image/png",
          },
        ],
        instructions: "Return summary JSON.",
        jsonSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
          },
          required: ["summary"],
        },
        provider: "codex",
        model: "gpt-5.4",
        timeoutMs: 30_000,
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
      }),
    ).rejects.toThrow("Codex structured extraction JSON did not match schema");
  });
});
