import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { requestBodyText, requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OllamaModelWithContext } from "./provider-models.js";
import {
  buildAppGuidedOllamaModel,
  buildOllamaModelsConfig,
  discoverOllamaModelsForSetup,
  selectAppGuidedOllamaModelFromDiscovery,
} from "./setup-model-selection.js";
import { configureOllamaNonInteractive, promptAndConfigureOllama } from "./setup.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function pendingAbortableResponse(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
      once: true,
    });
  });
}

describe("Ollama onboarding model selection", () => {
  it("retains freshly inspected size when using a configured cloud definition", () => {
    const model = buildAppGuidedOllamaModel({
      baseUrl: "http://127.0.0.1:11434",
      model: { name: "compact-chat:cloud" },
      showInfo: {
        contextWindow: 32_768,
        capabilities: ["completion", "tools"],
        parameterCount: 4_000_000_000,
      },
      configuredCloudModel: {
        id: "compact-chat:cloud",
        name: "Compact Chat",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_768,
        maxTokens: 8192,
      },
    });
    expect(model?.parameterCount).toBe(4_000_000_000);
  });

  it.each([{ remote_host: "https://ollama.com" }, { remote_model: "upstream-cloud-model" }])(
    "keeps a remote alias output budget during setup: %j",
    (remote) => {
      const models = buildOllamaModelsConfig(
        ["private-alias", "local-model"],
        new Map<string, OllamaModelWithContext>([
          ["private-alias", { name: "private-alias", contextWindow: 262_144, ...remote }],
          ["local-model", { name: "local-model", contextWindow: 262_144 }],
        ]),
      );
      expect(models.map(({ id, maxTokens }) => ({ id, maxTokens }))).toEqual([
        { id: "private-alias", maxTokens: 262_144 },
        { id: "local-model", maxTokens: 8192 },
      ]);
    },
  );

  it("keeps discovery-only parameter metadata out of user config", () => {
    const models = buildOllamaModelsConfig(
      ["model"],
      new Map([["model", { name: "model", parameterCount: 4_000_000_000 }]]),
    );
    expect(models[0]).not.toHaveProperty("parameterCount");
  });

  it("selects a deterministic tools-capable model with enough context", () => {
    expect(
      selectAppGuidedOllamaModelFromDiscovery([
        { name: "llama3:8b", contextWindow: 32_768, capabilities: ["tools"] },
        { name: "qwen3:0.6b", contextWindow: 40_960, capabilities: ["tools"] },
        { name: "gemma4:e4b", contextWindow: 8_192, capabilities: ["tools"] },
      ]),
    ).toBe("qwen3:0.6b");
  });

  it("selects the smallest explicitly non-thinking model during interactive setup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        if (url.endsWith("/api/tags")) {
          return Response.json({
            models: [
              { name: "deepseek-r1:1b", size: 100 },
              { name: "llama3:70b", size: 70_000 },
            ],
          });
        }
        if (url.endsWith("/api/show")) {
          return Response.json({
            model_info: { "test.context_length": 32_768 },
            capabilities: ["completion", "tools"],
          });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const prompter = {
      select: vi.fn().mockResolvedValueOnce("local-only"),
      text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;
    const result = await promptAndConfigureOllama({ cfg: {}, prompter });
    const selected = result.config.models?.providers?.ollama?.models?.find(
      (model) => model.id === "deepseek-r1:1b",
    );

    expect(selected?.reasoning).toBe(false);
    expect(result.defaultModel).toBe("ollama/deepseek-r1:1b");
  });

  it.each([
    {
      description: "model inspection fails",
      showResponse: () => Response.json({ error: "inspection unavailable" }, { status: 503 }),
    },
  ])(
    "selects and configures list-advertised models when $description",
    async ({ showResponse }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) =>
          requestUrl(input).endsWith("/api/tags")
            ? Response.json({
                models: [
                  {
                    name: "gemma4:e2b",
                    size: 2_000_000_000,
                    details: { context_length: 32_768 },
                    capabilities: ["completion", "tools"],
                  },
                ],
              })
            : showResponse(),
        ),
      );
      const prompter = {
        select: vi.fn().mockResolvedValueOnce("local-only"),
        text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
        note: vi.fn(async () => undefined),
        confirm: vi.fn().mockResolvedValue(false),
      } as unknown as WizardPrompter;

      const result = await promptAndConfigureOllama({ cfg: {}, prompter });

      expect(result.defaultModel).toBe("ollama/gemma4:e2b");
      expect(result.config.models?.providers?.ollama?.models).toContainEqual(
        expect.objectContaining({
          id: "gemma4:e2b",
          contextWindow: 32_768,
          compat: expect.objectContaining({ supportsTools: true }),
        }),
      );
      expect(prompter.confirm).not.toHaveBeenCalled();
    },
  );

  it("preserves incomplete remote-model-only capabilities during interactive setup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        requestUrl(input).endsWith("/api/tags")
          ? Response.json({
              models: [
                {
                  name: "deepseek-r1:remote",
                  remote_model: "upstream-deepseek-r1",
                  size: 2_000_000_000,
                  details: { context_length: 32_768 },
                  capabilities: ["tools"],
                },
              ],
            })
          : Response.json({}),
      ),
    );
    const prompter = {
      select: vi.fn().mockResolvedValueOnce("cloud-local"),
      text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
      note: vi.fn(async () => undefined),
      confirm: vi.fn().mockResolvedValue(false),
    } as unknown as WizardPrompter;

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });

    expect(result.defaultModel).toBe("ollama/deepseek-r1:remote");
    expect(result.config.models?.providers?.ollama?.models).toContainEqual(
      expect.objectContaining({
        id: "deepseek-r1:remote",
        contextWindow: 32_768,
        reasoning: true,
        compat: expect.objectContaining({ supportsTools: true }),
      }),
    );
  });

  it.each([
    ["local-only", "completion"],
    ["cloud-local", "embedding"],
  ] as const)(
    "respects %s mode with %s remote rows before inspecting and configuring mixed inventory",
    async (mode, remoteCapability) => {
      const remoteModels = Array.from({ length: 201 }, (_, index) => ({
        name: index % 3 === 2 ? `remote-${index}:cloud` : `remote-${index}:latest`,
        ...(index % 3 === 0 ? { remote_host: "https://ollama.com" } : {}),
        ...(index % 3 === 1 ? { remote_model: `upstream-${index}` } : {}),
        size: 1,
      }));
      const inspected: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (requestUrl(input).endsWith("/api/tags")) {
            return Response.json({
              models: [...remoteModels, { name: "local-chat:latest", size: 500 }],
            });
          }
          if (requestUrl(input).endsWith("/api/show")) {
            const { model } = JSON.parse(requestBodyText(init?.body));
            inspected.push(model);
            return Response.json({
              capabilities: [
                model.startsWith("remote-") ? remoteCapability : "completion",
                "tools",
              ],
              model_info: { "test.context_length": 32_768 },
            });
          }
          return Response.json({});
        }),
      );
      const prompter = {
        select: vi.fn().mockResolvedValueOnce(mode),
        text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
        note: vi.fn(async () => undefined),
        confirm: vi.fn().mockResolvedValue(false),
      } as unknown as WizardPrompter;

      const result = await promptAndConfigureOllama({ cfg: {}, prompter });
      const configured = result.config.models?.providers?.ollama?.models.map((model) => model.id);

      if (mode === "local-only") {
        expect(inspected).toEqual(["local-chat:latest"]);
        expect(result.defaultModel).toBe("ollama/local-chat:latest");
        expect(configured).toContain("local-chat:latest");
        expect(configured?.filter((name) => name.startsWith("remote-"))).toEqual([]);
      } else {
        expect(inspected).toContain(remoteModels[0]?.name);
        if (remoteCapability === "embedding") {
          expect(inspected).toContain("local-chat:latest");
          expect(result.defaultModel).toBe("ollama/local-chat:latest");
          expect(configured?.filter((name) => name.startsWith("remote-"))).toEqual([]);
        } else {
          expect(configured).toEqual(
            expect.arrayContaining(remoteModels.map((model) => model.name)),
          );
        }
      }
    },
  );

  describe("non-interactive defaults", () => {
    it.each([
      ["completion and embedding", ["completion", "embedding"], undefined, true, true],
    ] as const)(
      "respects %s capabilities when selecting and configuring a default",
      async (_description, capabilities, inspectedCapabilities, useRemote, supportsTools) => {
        const remoteName = "remote-model:latest";
        const localName = "local-chat:latest";
        vi.stubGlobal(
          "fetch",
          vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            if (requestUrl(input).endsWith("/api/tags")) {
              return Response.json({
                models: [
                  { name: remoteName, remote_model: "upstream-model", size: 1, capabilities },
                  { name: localName, size: 500 },
                ],
              });
            }
            if (requestUrl(input).endsWith("/api/show")) {
              const { model } = JSON.parse(requestBodyText(init?.body));
              return Response.json({
                model_info: { "test.context_length": 32_768 },
                capabilities:
                  model === remoteName ? inspectedCapabilities : ["completion", "tools"],
              });
            }
            return Response.json({});
          }),
        );
        const expectedDefault = `ollama/${useRemote ? remoteName : localName}`;
        const config = await configureOllamaNonInteractive({
          nextConfig: {},
          opts: { customBaseUrl: "http://127.0.0.1:11434" },
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        });
        expect(config.agents?.defaults?.model).toEqual({ primary: expectedDefault });
        const configured = config.models?.providers?.ollama?.models;
        expect(configured).toContainEqual(expect.objectContaining({ id: localName }));
        const remote = configured?.find((model) => model.id === remoteName);
        if (supportsTools === undefined) {
          expect(remote).toBeUndefined();
        } else {
          expect(remote).toMatchObject({ id: remoteName, compat: { supportsTools } });
        }
      },
    );
  });

  it("aborts pending context enrichment with the setup signal", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(input).endsWith("/api/tags")) {
          return new Response(JSON.stringify({ models: [{ name: "gemma4" }] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return pendingAbortableResponse(init?.signal);
      }),
    );

    const discovery = discoverOllamaModelsForSetup({
      baseUrl: "http://127.0.0.1:11434",
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });
    controller.abort();

    await expect(discovery).rejects.toMatchObject({ name: "AbortError" });
  });
});
