import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  ImageDescriptionRequest,
  StructuredExtractionRequest,
} from "openclaw/plugin-sdk/media-understanding";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCodexMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { codexModel as baseModel } from "./src/app-server/bounded-turn.test-harness.js";
import type { CodexAppServerClient } from "./src/app-server/client.js";
import {
  threadStartResult as baseThreadStartResult,
  turnStartResult as baseTurnStartResult,
} from "./src/app-server/codex-app-server.test-fixtures.js";
import type { CodexServerNotification, JsonValue } from "./src/app-server/protocol.js";
import type { CodexAppServerClientFactory } from "./src/app-server/shared-client.js";

const sharedClientMocks = vi.hoisted(() => ({
  createIsolatedCodexAppServerClient: vi.fn(),
}));

const imageInput = { type: "image", url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=" };
const summarySchema = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
};

function expectBoundedThread(
  requests: Array<{ method: string; params?: JsonValue }>,
  developerInstructions: string,
) {
  expect(requests.map(({ method }) => method)).toEqual([
    "model/list",
    "thread/start",
    "turn/start",
  ]);
  expect(requests[1]?.params).toEqual({
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
      "features.shell_tool": false,
      "features.standalone_web_search": false,
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

function expectStartup(
  clientFactory: ReturnType<typeof vi.fn<CodexAppServerClientFactory>>,
  config: ImageDescriptionRequest["cfg"],
  agentDir?: string,
) {
  const options = clientFactory.mock.calls[0]?.[0];
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

function threadStartResult() {
  const result = baseThreadStartResult("thread-1", "/tmp/openclaw-agent");
  return {
    ...result,
    thread: { ...result.thread, ephemeral: true, cliVersion: "0.149.0" },
    model: "gpt-5.4",
    approvalPolicy: "on-request",
  };
}

function turnStartResult(status = "inProgress", items: JsonValue[] = []) {
  return { turn: { ...baseTurnStartResult("turn-1", status).turn, items } };
}

function createFakeClient(options?: {
  inputModalities?: string[];
  completeWithItems?: boolean;
  deferTurnCompletion?: boolean;
  approvalRequestMethod?: string;
  responseText?: string;
  onTurnStart?: () => void;
}) {
  const notifications = new Set<(notification: CodexServerNotification) => void>();
  type RequestHandler = Parameters<CodexAppServerClient["addRequestHandler"]>[0];
  const requestHandlers = new Set<RequestHandler>();
  const requests: Array<{ method: string; params?: JsonValue }> = [];
  const approvalResponses: JsonValue[] = [];
  const request = vi.fn(async (method: string, params?: JsonValue) => {
    requests.push({ method, params });
    if (method === "model/list") {
      const model = baseModel();
      model.description = "GPT-5.4";
      model.inputModalities = options?.inputModalities ?? ["text", "image"];
      return { data: [model], nextCursor: null };
    }
    if (method === "thread/start") {
      return threadStartResult();
    }
    if (method === "turn/interrupt") {
      queueMicrotask(() => {
        for (const notify of notifications) {
          notify({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: turnStartResult("interrupted").turn,
            },
          });
        }
      });
      return {};
    }
    if (method === "turn/start") {
      options?.onTurnStart?.();
      const approvalMethod = options?.approvalRequestMethod;
      const approvals = approvalMethod
        ? [...requestHandlers].map(async (handler) => {
            const response = await handler({
              id: "approval-1",
              method: approvalMethod,
              params: { threadId: "thread-1", turnId: "turn-1" },
            });
            if (response !== undefined) {
              approvalResponses.push(response);
            }
          })
        : [];
      const completeTurn = () => {
        if (!options?.completeWithItems && !options?.deferTurnCompletion) {
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
      // Return turn/start before waiting for keyed approvals; complete only after their replies.
      if (approvals.length > 0) {
        void Promise.all(approvals).then(completeTurn);
      } else {
        completeTurn();
      }
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
    return {};
  });

  const closeAndWait = vi.fn(async () => true);
  const client = {
    request,
    addNotificationHandler(handler: (notification: CodexServerNotification) => void) {
      notifications.add(handler);
      return () => notifications.delete(handler);
    },
    addRequestHandler(handler: RequestHandler) {
      requestHandlers.add(handler);
      return () => requestHandlers.delete(handler);
    },
    addCloseHandler: () => () => undefined,
    closeAndWait,
  } as unknown as CodexAppServerClient;

  const clientFactory = vi.fn<CodexAppServerClientFactory>(async () => client);
  const provider = buildCodexMediaUnderstandingProvider({ clientFactory });
  return { client, clientFactory, provider, requests, approvalResponses, closeAndWait };
}

describe("codex media understanding provider", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    sharedClientMocks.createIsolatedCodexAppServerClient.mockReset();
  });

  it("does not start a bounded turn for an already-aborted media request", async () => {
    const clientFactory = vi.fn();
    const provider = buildCodexMediaUnderstandingProvider({ clientFactory });
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled Codex media request"));

    await expect(
      provider.describeImage?.(imageRequest({ signal: controller.signal })),
    ).rejects.toThrow("caller cancelled Codex media request");

    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("abandons app-server startup when the media request aborts", async () => {
    const startupReady = createDeferred<void>();
    const clientFactory = vi.fn<CodexAppServerClientFactory>(
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
    const provider = buildCodexMediaUnderstandingProvider({ clientFactory });
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
    const { provider, requests, clientFactory } = createFakeClient();
    const cfg = { auth: { order: { openai: ["openai:work"] } } };

    const result = await provider.describeImage?.(
      imageRequest({ prompt: "Describe briefly.", cfg }),
    );

    expect(result).toEqual({ text: "A red square.", model: "gpt-5.4" });
    expectStartup(clientFactory, cfg, "/tmp/openclaw-agent");
    expectBoundedThread(
      requests,
      "You are OpenClaw's bounded image-understanding worker. Describe only the provided image content. Do not call tools, edit files, or ask follow-up questions.",
    );
    expect(requests[2]?.params).toEqual({
      threadId: "thread-1",
      input: [{ type: "text", text: "Describe briefly.", text_elements: [] }, imageInput],
      approvalPolicy: "on-request",
      effort: "low",
    });
  });

  it("treats a blank agent directory as absent when starting the app-server", async () => {
    const { provider, requests, clientFactory } = createFakeClient();
    const cfg = {};

    await provider.describeImage?.(imageRequest({ cfg, agentDir: " " }));

    expectStartup(clientFactory, cfg);
    expect(requests[1]?.params).toEqual(expect.objectContaining({ cwd: process.cwd() }));
    expect(requests[2]?.params).not.toHaveProperty("cwd");
  });

  it("preserves configured WebSocket transport for media turns", async () => {
    const { client, requests } = createFakeClient();
    const clientFactory = vi.fn<CodexAppServerClientFactory>(async () => client);
    const provider = buildCodexMediaUnderstandingProvider({
      pluginConfig: {
        appServer: {
          transport: "websocket",
          url: "ws://127.0.0.1:4501",
        },
      },
      clientFactory,
    });

    await provider.describeImage?.(imageRequest());

    const factoryOptions = clientFactory.mock.calls[0]?.[0];
    expect(factoryOptions).toEqual(
      expect.objectContaining({
        startOptions: expect.objectContaining({
          transport: "websocket",
          url: "ws://127.0.0.1:4501",
        }),
        authProfileId: undefined,
        agentDir: "/tmp/openclaw-agent",
        config: {},
      }),
    );
    expect(factoryOptions?.timeoutMs).toBeGreaterThan(0);
    expect(factoryOptions?.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(requests[1]?.params).toEqual(expect.objectContaining({ cwd: "/tmp/openclaw-agent" }));
    expect(requests[2]?.params).not.toHaveProperty("cwd");
  });

  it("interrupts a configured app-server turn when the media request aborts", async () => {
    const controller = new AbortController();
    const { client, requests } = createFakeClient({
      deferTurnCompletion: true,
      onTurnStart: () => setTimeout(() => controller.abort(new Error("media cancelled")), 0),
    });
    const provider = buildCodexMediaUnderstandingProvider({
      pluginConfig: { appServer: { transport: "websocket", url: "ws://127.0.0.1:4501" } },
      clientFactory: async () => client,
    });

    await expect(
      provider.describeImage?.(imageRequest({ signal: controller.signal })),
    ).rejects.toThrow();

    expect(requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
  });

  it("passes the scoped auth store into isolated app-server startup", async () => {
    const { client, closeAndWait } = createFakeClient();
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

    await provider.describeImage?.(imageRequest({ authStore }));

    expect(sharedClientMocks.createIsolatedCodexAppServerClient).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileStore: authStore }),
    );
    expect(closeAndWait).toHaveBeenCalledOnce();
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
    const { provider, approvalResponses } = createFakeClient({
      approvalRequestMethod: "item/permissions/requestApproval",
    });

    await provider.describeImage?.(imageRequest({ prompt: "Describe briefly." }));

    expect(approvalResponses).toEqual([{ permissions: {}, scope: "turn" }]);
  });

  it("extracts text from terminal turn items", async () => {
    const { provider } = createFakeClient({ completeWithItems: true });
    const { buffer, fileName, mime, ...request } = imageRequest({ prompt: "Describe briefly." });
    const result = await provider.describeImages?.({
      ...request,
      images: [{ buffer, fileName, mime }],
    });

    expect(result).toEqual({ text: "A blue circle.", model: "gpt-5.4" });
  });

  it("rejects text-only Codex app-server models before starting a turn", async () => {
    const { provider, requests } = createFakeClient({ inputModalities: ["text"] });

    await expect(provider.describeImage?.(imageRequest())).rejects.toThrow(
      "Codex app-server model does not support images: gpt-5.4",
    );
    expect(requests.map((entry) => entry.method)).toEqual(["model/list"]);
  });

  it("runs structured extraction through the same bounded Codex app-server path", async () => {
    const { provider, requests } = createFakeClient({
      responseText: '{"summary":"red square","tags":["shape"]}',
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
    const turnParams = requests[2]?.params;
    expect(turnParams).toEqual({
      threadId: "thread-1",
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
    const { provider, requests } = createFakeClient({
      inputModalities: ["text"],
      responseText: '{"summary":"only text"}',
    });

    await expect(
      provider.extractStructured?.(
        structuredRequest({
          input: [{ type: "text", text: "The answer is only text." }],
        }),
      ),
    ).rejects.toThrow("Codex structured extraction requires at least one image input.");
    expect(requests).toEqual([]);
  });

  it("returns a controlled error when structured JSON parsing fails", async () => {
    const { provider } = createFakeClient({ responseText: "not json" });

    await expect(provider.extractStructured?.(structuredRequest())).rejects.toThrow(
      "Codex structured extraction returned invalid JSON.",
    );
  });

  it("validates structured extraction JSON against the requested schema", async () => {
    const { provider } = createFakeClient({
      responseText: '{"summary":123,"tags":["shape"]}',
    });

    await expect(
      provider.extractStructured?.(structuredRequest({ jsonSchema: summarySchema })),
    ).rejects.toThrow("Codex structured extraction JSON did not match schema");
  });
});
