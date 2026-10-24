import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  ImageDescriptionRequest,
  StructuredExtractionRequest,
} from "openclaw/plugin-sdk/media-understanding";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCodexMediaUnderstandingProvider } from "./media-understanding-provider.js";
import {
  codexModel,
  completedTurnResult,
  createClientFactory,
} from "./src/app-server/bounded-turn.test-harness.js";
import type { CodexAppServerClientFactory } from "./src/app-server/shared-client.js";

const sharedClientMocks = vi.hoisted(() => ({
  createIsolatedCodexAppServerClient: vi.fn<CodexAppServerClientFactory>(),
}));

const imageInput = { type: "image", url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=" };
const turnIdentity = { threadId: "thread-finalizer", turnId: "turn-finalizer" };
const websocketConfig = {
  appServer: { transport: "websocket" as const, url: "ws://127.0.0.1:4501" },
};
const summarySchema = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
};

function expectBoundedThread(
  requests: ReturnType<typeof createClientFactory>["request"]["mock"]["calls"],
  developerInstructions: string,
) {
  expect(requests.map(([method]) => method)).toEqual(["model/list", "thread/start", "turn/start"]);
  expect(requests[1]?.[1]).toEqual({
    model: "gpt-5.4",
    modelProvider: "openai",
    cwd: "/tmp/openclaw-agent",
    approvalPolicy: "on-request",
    sandbox: "read-only",
    serviceName: "OpenClaw",
    developerInstructions,
    config: {
      "agents.enabled": false,
      "features.apps": false,
      "features.goals": false,
      "features.code_mode": false,
      "features.code_mode_only": false,
      "features.image_generation": false,
      "features.multi_agent": false,
      "features.multi_agent_v2": false,
      "features.plugins": false,
      "features.recommended_plugins": false,
      "features.shell_tool": false,
      "features.standalone_web_search": false,
      "features.tool_suggest": false,
      "features.unified_exec": false,
      project_doc_max_bytes: 131_072,
      "tools.update_plan.enabled": false,
      web_search: "disabled",
    },
    environments: [],
    dynamicTools: [],
    experimentalRawEvents: true,
    ephemeral: true,
  });
}

function expectStartup(config: ImageDescriptionRequest["cfg"], agentDir?: string) {
  const options = sharedClientMocks.createIsolatedCodexAppServerClient.mock.calls[0]?.[0];
  expect(options).toMatchObject({
    startOptions: expect.any(Object),
    authProfileId: undefined,
    agentDir,
    config,
  });
  expect(options?.timeoutMs).toBeGreaterThan(0);
  expect(options?.timeoutMs).toBeLessThanOrEqual(30_000);
}

vi.mock("./src/app-server/shared-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./src/app-server/shared-client.js")>();
  return {
    ...actual,
    createIsolatedCodexAppServerClient: sharedClientMocks.createIsolatedCodexAppServerClient,
    retireSharedCodexAppServerClientIfCurrent: () => undefined,
  };
});

function imageRequest(overrides: Partial<ImageDescriptionRequest> = {}): ImageDescriptionRequest {
  return {
    buffer: Buffer.from("image-bytes"),
    fileName: "image.png",
    mime: "image/png",
    provider: "codex",
    model: "gpt-5.4",
    timeoutMs: 30_000,
    cfg: {},
    agentDir: "/tmp/openclaw-agent",
    ...overrides,
  };
}

function structuredRequest(
  overrides: Partial<StructuredExtractionRequest> = {},
): StructuredExtractionRequest {
  const { buffer, fileName, mime, ...request } = imageRequest();
  return {
    ...request,
    input: [
      { type: "text", text: "Extract JSON." },
      { type: "image", buffer, fileName, mime },
    ],
    instructions: "Return summary JSON.",
    ...overrides,
  };
}

function createFakeClient(
  options: Parameters<typeof createClientFactory>[0] = {},
  pluginConfig?: Parameters<typeof buildCodexMediaUnderstandingProvider>[0],
) {
  const fake = createClientFactory({
    models: [{ ...codexModel(), inputModalities: ["text", "image"] }],
    assistantDelta: "A red square.",
    terminalItems: [],
    ...options,
  });
  const clientFactory = sharedClientMocks.createIsolatedCodexAppServerClient.mockImplementation(
    async (params) => {
      const client = await fake.factory(params);
      vi.spyOn(client, "closeAndWait");
      return client;
    },
  );
  const provider = buildCodexMediaUnderstandingProvider(pluginConfig);
  return { ...fake, clientFactory, provider, requests: fake.request.mock.calls };
}

describe("codex media understanding provider", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sharedClientMocks.createIsolatedCodexAppServerClient.mockReset();
  });

  it("does not start a bounded turn for an already-aborted media request", async () => {
    const clientFactory = sharedClientMocks.createIsolatedCodexAppServerClient;
    const provider = buildCodexMediaUnderstandingProvider();
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled Codex media request"));

    await expect(
      provider.describeImage?.(imageRequest({ signal: controller.signal })),
    ).rejects.toThrow("caller cancelled Codex media request");

    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("abandons app-server startup when the media request aborts", async () => {
    const startupReady = createDeferred<void>();
    const clientFactory = sharedClientMocks.createIsolatedCodexAppServerClient.mockImplementation(
      async (options) =>
        await new Promise<never>((_, reject) => {
          options?.abandonSignal?.addEventListener(
            "abort",
            () => {
              const reason = options.abandonSignal?.reason;
              reject(reason instanceof Error ? reason : new Error("Codex startup aborted"));
            },
            { once: true },
          );
          startupReady.resolve();
        }),
    );
    const provider = buildCodexMediaUnderstandingProvider();
    const controller = new AbortController();
    const result = provider.describeImage?.(imageRequest({ signal: controller.signal }));

    const rejection = expect(result).rejects.toThrow("caller cancelled Codex startup");
    await startupReady.promise;
    expect(clientFactory).toHaveBeenCalledOnce();
    controller.abort(new Error("caller cancelled Codex startup"));
    await rejection;
    expect(clientFactory.mock.calls[0]?.[0]?.abandonSignal).toBe(controller.signal);
  });

  it("runs image understanding through a bounded Codex app-server turn", async () => {
    const { provider, requests } = createFakeClient();
    const cfg = { auth: { order: { openai: ["openai:work"] } } };

    const result = await provider.describeImage?.(
      imageRequest({ prompt: "Describe briefly.", cfg }),
    );

    expect(result).toEqual({ text: "A red square.", model: "gpt-5.4" });
    expectStartup(cfg, "/tmp/openclaw-agent");
    expectBoundedThread(
      requests,
      "You are OpenClaw's bounded image-understanding worker. Describe only the provided image content. Do not call tools, edit files, or ask follow-up questions.",
    );
    expect(requests[2]?.[1]).toEqual({
      threadId: turnIdentity.threadId,
      input: [{ type: "text", text: "Describe briefly.", text_elements: [] }, imageInput],
      approvalPolicy: "on-request",
      effort: "low",
    });
  });

  it("treats a blank agent directory as absent when starting the app-server", async () => {
    const { provider, requests } = createFakeClient();
    const cfg = {};

    await provider.describeImage?.(imageRequest({ cfg, agentDir: " " }));

    expectStartup(cfg);
    expect(requests[1]?.[1]).toEqual(expect.objectContaining({ cwd: process.cwd() }));
    expect(requests[2]?.[1]).not.toHaveProperty("cwd");
  });

  it("preserves configured WebSocket transport for media turns", async () => {
    const { provider, requests, clientFactory } = createFakeClient(
      {},
      { pluginConfig: websocketConfig },
    );

    await provider.describeImage?.(imageRequest());

    const factoryOptions = clientFactory.mock.calls[0]?.[0];
    expect(factoryOptions?.startOptions).toMatchObject(websocketConfig.appServer);
    expectStartup({}, "/tmp/openclaw-agent");
    expect(requests[1]?.[1]).toEqual(expect.objectContaining({ cwd: "/tmp/openclaw-agent" }));
    expect(requests[2]?.[1]).not.toHaveProperty("cwd");
  });

  it("interrupts a configured app-server turn when the media request aborts", async () => {
    const controller = new AbortController();
    const { provider, requests } = createFakeClient(
      {
        completeTurn: false,
        beforeRequest: async (method) => {
          if (method === "turn/start") {
            setTimeout(() => controller.abort(new Error("media cancelled")), 0);
          }
        },
      },
      { pluginConfig: websocketConfig },
    );

    await expect(
      provider.describeImage?.(imageRequest({ signal: controller.signal })),
    ).rejects.toThrow();

    expect(requests.map(([method, params]) => ({ method, params }))).toContainEqual({
      method: "turn/interrupt",
      params: turnIdentity,
    });
  });

  it("passes the scoped auth store into isolated app-server startup", async () => {
    const { provider, clientFactory } = createFakeClient();
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

    await provider.describeImage?.(imageRequest({ authStore }));

    expect(sharedClientMocks.createIsolatedCodexAppServerClient).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileStore: authStore }),
    );
    expect((await clientFactory.mock.results[0]?.value)?.closeAndWait).toHaveBeenCalledOnce();
  });

  it("clamps oversized image understanding turn timeouts", async () => {
    // Freeze the clock: startup time is subtracted from the clamped deadline.
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { provider } = createFakeClient();
    const result = await provider.describeImage?.(
      imageRequest({ timeoutMs: MAX_TIMER_TIMEOUT_MS + 1 }),
    );
    expect(result?.text).toBe("A red square.");
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("declines approval requests during image understanding", async () => {
    const started = createDeferred<void>();
    const { provider, handleServerRequest, notify } = createFakeClient({
      completeTurn: false,
      beforeRequest: async (method) => {
        if (method === "turn/start") {
          started.resolve();
        }
      },
    });
    const result = provider.describeImage?.(imageRequest({ prompt: "Describe briefly." }));
    await started.promise;
    await expect(
      handleServerRequest({
        id: "approval-1",
        method: "item/permissions/requestApproval",
        params: turnIdentity,
      }),
    ).resolves.toEqual({ permissions: {}, scope: "turn" });
    await notify({
      method: "turn/completed",
      params: { ...turnIdentity, ...completedTurnResult() },
    });
    await result;
  });

  it("extracts text from terminal turn items", async () => {
    const { provider, request: rpc } = createFakeClient();
    const send = rpc.getMockImplementation()!;
    rpc.mockImplementation(async (method, params, options) =>
      method === "turn/start"
        ? {
            turn: {
              ...completedTurnResult().turn,
              items: [{ id: "msg-1", type: "agentMessage", text: "A blue circle." }],
            },
          }
        : send(method, params, options),
    );
    const { buffer, fileName, mime, ...request } = imageRequest({ prompt: "Describe briefly." });
    const result = await provider.describeImages?.({
      ...request,
      images: [{ buffer, fileName, mime }],
    });

    expect(result).toEqual({ text: "A blue circle.", model: "gpt-5.4" });
  });

  it("rejects text-only Codex app-server models before starting a turn", async () => {
    const { provider, requests } = createFakeClient({ models: [codexModel()] });

    await expect(provider.describeImage?.(imageRequest())).rejects.toThrow(
      "Codex app-server model does not support images: gpt-5.4",
    );
    expect(requests.map(([method]) => method)).toEqual(["model/list"]);
  });

  it("runs structured extraction through the same bounded Codex app-server path", async () => {
    const { provider, requests } = createFakeClient({
      assistantDelta: '{"summary":"red square","tags":["shape"]}',
    });

    const result = await provider.extractStructured?.(
      structuredRequest({
        instructions: "Return a compact evidence object.",
        schemaName: "example.media",
        jsonSchema: {
          ...summarySchema,
          properties: {
            summary: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      }),
    );

    expect(result).toEqual({
      text: '{"summary":"red square","tags":["shape"]}',
      parsed: { summary: "red square", tags: ["shape"] },
      model: "gpt-5.4",
      provider: "codex",
      contentType: "json",
    });
    expectBoundedThread(
      requests,
      "You are OpenClaw's bounded structured-extraction worker. Return only the requested extraction. Do not call tools, edit files, ask follow-up questions, or include secrets.",
    );
    const turnParams = requests[2]?.[1];
    expect(turnParams).toEqual({
      threadId: turnIdentity.threadId,
      approvalPolicy: "on-request",
      effort: "low",
      input: [
        {
          type: "text",
          text: expect.stringContaining("Return valid JSON only"),
          text_elements: [],
        },
        { type: "text", text: "Extract JSON.", text_elements: [] },
        imageInput,
      ],
    });
    expect(turnParams).not.toHaveProperty("model");
    expect(turnParams).not.toHaveProperty("cwd");
  });

  it("rejects text-only structured extraction before starting a turn", async () => {
    const { provider, requests } = createFakeClient({ models: [codexModel()] });

    await expect(
      provider.extractStructured?.(
        structuredRequest({
          input: [{ type: "text", text: "The answer is only text." }],
        }),
      ),
    ).rejects.toThrow("Codex structured extraction requires at least one image input.");
    expect(requests).toEqual([]);
  });

  it.each([
    ["not json", "Codex structured extraction returned invalid JSON.", undefined],
    [
      '{"summary":123,"tags":["shape"]}',
      "Codex structured extraction JSON did not match schema",
      summarySchema,
    ],
  ] as const)(
    "rejects invalid structured response %s",
    async (responseText, message, jsonSchema) => {
      const { provider } = createFakeClient({ assistantDelta: responseText });
      await expect(provider.extractStructured?.(structuredRequest({ jsonSchema }))).rejects.toThrow(
        message,
      );
    },
  );
});
