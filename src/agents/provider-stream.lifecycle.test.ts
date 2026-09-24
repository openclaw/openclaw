import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindModelLlmRuntime } from "../llm/model-runtime-binding.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { resolveProviderStreamFn } from "../plugins/provider-runtime.js";
import { resolveCompactionProviderStream } from "./embedded-agent-runner/compaction-diagnostics.js";
import { getModelProviderLocalServiceReconciler } from "./provider-local-service-reconcile.js";
import {
  attachModelProviderLocalService,
  stopManagedProviderLocalServices,
} from "./provider-local-service.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";

const { fetchWithSsrFGuard, prepare, providerStream, reconcile, runtimeHandle } = vi.hoisted(() => {
  const prepareMock = vi.fn(async () => undefined);
  const reconcileMock = vi.fn(async () => undefined);
  return {
    fetchWithSsrFGuard: vi.fn(),
    prepare: prepareMock,
    providerStream: vi.fn(),
    reconcile: reconcileMock,
    runtimeHandle: {
      provider: "test-provider",
      modelId: "test-model",
      plugin: {
        reconcileLocalService: reconcileMock,
        wrapStreamFn: ({ streamFn }: { streamFn: typeof providerStream }) => {
          return async (...args: Parameters<typeof providerStream>) => {
            await prepareMock();
            return streamFn(...args);
          };
        },
      },
    },
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard,
  withTrustedEnvProxyGuardedFetchMode: vi.fn((params) => params),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderStreamFn: vi.fn(() => providerStream),
}));

vi.mock("../plugins/provider-hook-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-hook-runtime.js")>();
  return {
    ...actual,
    resolveProviderRuntimePluginHandle: (
      params: Parameters<typeof actual.resolveProviderRuntimePluginHandle>[0],
    ) => ({ ...runtimeHandle, provider: params.provider, modelId: params.modelId }),
  };
});

describe("provider stream lifecycle registration", () => {
  beforeEach(() => {
    fetchWithSsrFGuard.mockReset().mockResolvedValue({
      response: new Response("ok"),
      finalUrl: "http://127.0.0.1:19432/v1/responses",
      release: vi.fn(async () => undefined),
    });
    prepare.mockClear();
    providerStream.mockReset();
    vi.mocked(resolveProviderStreamFn).mockClear();
    reconcile.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await stopManagedProviderLocalServices();
  });

  it("registers provider streams with the resolved runtime lifecycle handle", async () => {
    providerStream.mockReturnValue(createAssistantMessageEventStream());
    const apiRegistry = createApiRegistry();
    const llmRuntime = createLlmRuntime(apiRegistry);
    const model = bindModelLlmRuntime(
      {
        api: "test-lifecycle-provider",
        provider: "test-provider",
        id: "test-model",
        name: "Test Model",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1024,
        maxTokens: 512,
      },
      llmRuntime,
    );

    const streamFn = registerProviderStreamForModel({ model, wrapProviderStream: true });
    expect(streamFn).toBeTypeOf("function");
    expect(apiRegistry.getApiProvider("test-lifecycle-provider")).toBeDefined();
    await streamFn?.(model, {} as never, {});
    expect(getModelProviderLocalServiceReconciler(providerStream.mock.calls[0]![0])).toBe(
      reconcile,
    );
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
      providerStream.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    { label: "reloads before", reconcileError: undefined },
    { label: "fails closed before", reconcileError: new Error("preset reload failed") },
  ])("$label the first direct-compaction provider request", async ({ reconcileError }) => {
    const events: string[] = [];
    reconcile.mockImplementation(async () => {
      events.push("reload");
      if (reconcileError) {
        throw reconcileError;
      }
    });
    fetchWithSsrFGuard.mockImplementation(async () => {
      events.push("provider-request");
      return {
        response: new Response("ok"),
        finalUrl: "http://127.0.0.1:19432/v1/responses",
        release: vi.fn(async () => undefined),
      };
    });
    providerStream.mockImplementation(async (requestModel) => {
      const response = await buildGuardedModelFetch(requestModel)(
        "http://127.0.0.1:19432/v1/responses",
        { method: "POST", body: "{}" },
      );
      await response.text();
      return createAssistantMessageEventStream();
    });
    const apiRegistry = createApiRegistry();
    const llmRuntime = createLlmRuntime(apiRegistry);
    const model = attachModelProviderLocalService(
      bindModelLlmRuntime(
        {
          api: "ollama",
          provider: "ollama",
          id: "qwen3:8b",
          name: "Test Model",
          baseUrl: "http://127.0.0.1:19432/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1024,
          maxTokens: 512,
        },
        llmRuntime,
      ),
      {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        healthUrl: "http://127.0.0.1:19432/health",
      },
    );
    expect(apiRegistry.getApiProvider("ollama")).toBeUndefined();
    const streamFn = resolveCompactionProviderStream({
      effectiveModel: model,
      agentDir: "/tmp/test-agent",
      effectiveWorkspace: "/tmp/test-workspace",
      apiRegistry,
    });

    expect(vi.mocked(resolveProviderStreamFn).mock.calls[0]?.[0].context).toMatchObject({
      agentDir: "/tmp/test-agent",
      workspaceDir: "/tmp/test-workspace",
      provider: "ollama",
      modelId: "qwen3:8b",
      model: { api: "ollama", provider: "ollama", id: "qwen3:8b" },
    });
    expect(streamFn).toBeTypeOf("function");
    expect(apiRegistry.getApiProvider("ollama")).toBeDefined();

    if (reconcileError) {
      await expect(streamFn?.(model, {} as never, {})).rejects.toThrow(reconcileError.message);
    } else {
      await streamFn?.(model, {} as never, {});
    }
    expect(events).toEqual(reconcileError ? ["reload"] : ["reload", "provider-request"]);
  });
});
