import { withTimeout } from "@openclaw/fs-safe/advanced";
import { expectDefined } from "@openclaw/normalization-core";
import { jsonResponse, requestUrl, withServer } from "openclaw/plugin-sdk/test-env";
import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOllamaProvider,
  buildOllamaBaseUrlSsrFPolicy,
  buildOllamaModelDefinition,
  enrichOllamaCompletionModels,
  enrichOllamaModelsWithContext,
  fetchLoadedOllamaModelNames,
  fetchOllamaModels,
  queryOllamaModelShowInfo,
  toDynamicOllamaModel,
  type OllamaTagModel,
} from "./provider-models.js";
const localUrl = "http://127.0.0.1:11434";
const completion = ["completion"];

afterEach(() => vi.unstubAllGlobals());

async function discoverModel(url = localUrl) {
  const provider = await buildOllamaProvider(url);
  const model = expectDefined(provider.models[0], "discovered model");
  return {
    model,
    runtime: toDynamicOllamaModel({ provider: "ollama", providerConfig: provider, model }),
  };
}

function stubDiscovery(models: OllamaTagModel[], show: unknown = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) =>
      jsonResponse(requestUrl(input).endsWith("/api/tags") ? { models } : show),
    ),
  );
}

describe("ollama provider models", () => {
  it.each([
    { tagSize: "1.5B", expected: 1_500_000_000 },
    { tagSize: "494M", expected: 494_000_000 },
    { tagSize: "1.2T", expected: 1_200_000_000_000 },
    { tagSize: "4B", showCount: 70_000_000_000, expected: 70_000_000_000 },
    { showSize: "32.8B", expected: 32_800_000_000 },
    { tagSize: "unknown", expected: undefined },
  ])(
    "keeps total parameter metadata through discovery: %j",
    async ({ tagSize, showCount, showSize, expected }) => {
      stubDiscovery([{ name: "custom-model", details: { parameter_size: tagSize } }], {
        capabilities: completion,
        model_info: { "general.parameter_count": showCount },
        details: { parameter_size: showSize },
      });
      const { model, runtime } = await discoverModel();
      expect([model.parameterCount, runtime.parameterCount]).toEqual([expected, expected]);
    },
  );

  it("keeps incomplete cloud metadata discoverable with remote host metadata", async () => {
    const listed = {
      name: "deepseek-r1:671b",
      remote_host: "https://ollama.example",
      capabilities: ["vision"],
    };
    stubDiscovery([listed]);

    await expect(buildOllamaProvider(localUrl)).resolves.toMatchObject({
      models: [
        {
          id: listed.name,
          input: ["text", "image"],
          reasoning: true,
          compat: { supportsTools: true },
        },
      ],
    });
  });

  it("keeps strict node discovery closed when remote completion is only inferred", async () => {
    stubDiscovery([]);

    await expect(
      enrichOllamaCompletionModels(
        localUrl,
        [
          {
            name: "remote-chat:latest",
            remote_model: "upstream-chat:latest",
            capabilities: ["tools"],
          },
        ],
        { requireCompletionCapability: true },
      ),
    ).resolves.toEqual([]);
  });

  it("reads loaded models from /api/ps with remote auth", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(requestUrl(input)).toBe("https://ollama.example.com/api/ps");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-key");
      return jsonResponse({
        models: [{ name: "qwen3.5:4b" }, { model: "llama3.3:70b" }, { name: "   " }, {}],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchLoadedOllamaModelNames("https://ollama.example.com/v1", {
        apiKey: "private-key",
      }),
    ).resolves.toEqual({
      reachable: true,
      models: ["qwen3.5:4b", "llama3.3:70b"],
    });
  });

  it("scopes cached show metadata by credential", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/tags")) {
        return jsonResponse({ models: [{ name: "private-model", digest: "stable" }] });
      }
      const apiKey = new Headers(init?.headers).get("Authorization");
      return jsonResponse({
        model_info: {
          "private.context_length": apiKey === "Bearer account-a" ? 16_000 : 32_000,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [first, second, third] = await Promise.all(
      ["account-a", "account-b", "account-a"].map(
        async (apiKey) => await buildOllamaProvider("https://ollama.example.com", { apiKey }),
      ),
    );

    expect([first, second, third].map((provider) => provider?.models[0]?.contextWindow)).toEqual([
      16_000, 32_000, 16_000,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each([
    { id: "minimax-m2.7", contextWindow: 196_608, maxTokens: 204_800 },
    { id: "minimax-m3", contextWindow: 524_288, maxTokens: 524_288 },
    { id: "kimi-k3", contextWindow: 1_048_576, maxTokens: 1_048_576 },
    { id: "glm-5.2", contextWindow: 1_000_000, maxTokens: 131_072 },
  ])("keeps the cloud output budget for $id aliases", ({ id, contextWindow, maxTokens }) => {
    for (const modelId of [id, `${id}:cloud`, `${id}-cloud`]) {
      expect(
        buildOllamaModelDefinition(modelId, undefined, undefined, { remote: true }),
      ).toMatchObject({ id: modelId, contextWindow, maxTokens });
    }
  });

  it.each<[name: string, url: string, maxTokens: number, remote?: Partial<OllamaTagModel>]>([
    ["local-model", localUrl, 8192],
    ["minimax-m3", localUrl, 8192],
    ["kimi-k3", localUrl, 8192],
    ["minimax-m3", "https://ollama.com", 524_288],
    ["kimi-k3", "https://ollama.com", 1_048_576],
    ["glm-5.2:cloud", localUrl, 131_072],
    ["unknown:cloud", localUrl, 262_144],
    ["unknown", "https://ollama.com", 262_144],
    ["remote-stub", localUrl, 262_144, { remote_host: "https://ollama.com" }],
    ["remote-model-stub", localUrl, 262_144, { remote_model: "upstream-model" }],
  ])("discovers %s output limits at %s", async (name, url, maxTokens, remote) => {
    stubDiscovery([{ name, ...remote }], {
      capabilities: completion,
      model_info: { "test.context_length": 262_144 },
    });
    expect((await discoverModel(url)).runtime).toMatchObject({ id: name, maxTokens });
  });

  it("uses Modelfile num_ctx when it expands the discovered context window", async () => {
    const models = [{ name: "llama3-32k:latest" }];
    stubDiscovery(models, {
      model_info: { "llama.context_length": 8192 },
      parameters: 'stop "<|eot_id|>"\nnum_ctx 32768\nnum_keep 5',
      capabilities: completion,
    });
    expect(await enrichOllamaModelsWithContext(localUrl, models)).toEqual([
      { name: "llama3-32k:latest", contextWindow: 32768, capabilities: completion },
    ]);
  });

  it("closes real failed discovery sockets while preserving successful discovery", async () => {
    const socketClosures = new Map<string, Promise<void>>();
    let mode: "failure" | "success" = "failure";

    const handleRequest: Parameters<typeof withServer>[0] = (request, response) => {
      const path = request.url;
      if (path !== "/api/tags" && path !== "/api/show") {
        response.writeHead(404);
        response.end();
        return;
      }

      if (mode === "failure") {
        socketClosures.set(
          path,
          new Promise<void>((resolve) => {
            request.socket.once("close", () => resolve());
          }),
        );
        response.writeHead(503, { "content-type": "text/plain" });
        // Leave the body open so only real client cancellation can close its socket.
        response.write("ollama unavailable");
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          path === "/api/tags"
            ? { models: [{ name: "llama3:8b" }] }
            : {
                model_info: { "llama.context_length": 32768 },
                capabilities: ["completion", "tools"],
              },
        ),
      );
    };

    const waitForSocketClose = async (path: string): Promise<void> => {
      await withTimeout(
        expectDefined(socketClosures.get(path), `failed discovery socket for ${path}`),
        2_000,
        { message: `Failed discovery socket was not closed for ${path}` },
      );
    };

    await withServer(handleRequest, async (baseUrl) => {
      await expect(fetchOllamaModels(baseUrl)).resolves.toEqual({
        reachable: true,
        models: [],
      });
      await waitForSocketClose("/api/tags");

      await expect(queryOllamaModelShowInfo(baseUrl, "llama3:8b")).resolves.toEqual({
        showInspectionFailed: true,
      });
      await waitForSocketClose("/api/show");

      mode = "success";
      await expect(fetchOllamaModels(baseUrl)).resolves.toEqual({
        reachable: true,
        models: [{ name: "llama3:8b" }],
      });
      await expect(queryOllamaModelShowInfo(baseUrl, "llama3:8b")).resolves.toEqual({
        contextWindow: 32768,
        capabilities: ["completion", "tools"],
      });
    });
  });

  it("preserves remote-model-only list capabilities after a live inspection failure", async () => {
    const listed = {
      name: "remote-chat:latest",
      remote_model: "upstream-chat:latest",
      digest: "sha256:remote-model-list-metadata",
      details: { context_length: 32_768 },
      capabilities: ["tools"],
    };

    await withServer(
      (request, response) => {
        response.setHeader("Content-Type", "application/json");
        if (request.url === "/api/tags") {
          response.end(JSON.stringify({ models: [listed] }));
          return;
        }
        if (request.url === "/api/show") {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: "show failed" }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
      },
      async (baseUrl) => {
        expect((await discoverModel(baseUrl)).model).toMatchObject({
          id: listed.name,
          contextWindow: 32_768,
          compat: { supportsTools: true },
          reasoning: false,
        });
      },
    );
  });

  it.each(["tags", "show"] as const)(
    "bounds %s discovery JSON and cancels oversized streams",
    async (endpoint) => {
      // Advertise 32 MiB, twice the shared JSON cap, and observe early cancellation.
      const oversized = oversizedJsonResponse({ chunkCount: 32, chunkSize: 1024 * 1024 });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => oversized.response),
      );
      const result =
        endpoint === "tags"
          ? await fetchOllamaModels(localUrl)
          : await queryOllamaModelShowInfo(localUrl, "evil-model:latest");
      expect(result).toEqual(
        endpoint === "tags" ? { reachable: false, models: [] } : { showInspectionFailed: true },
      );
      expect(oversized.wasCanceled()).toBe(true);
      expect(oversized.getReadCount()).toBeLessThan(32);
    },
  );
});

describe("Ollama model discovery failures", () => {
  it.each([503, "offline", "invalid-json", "missing-models"])(
    "preserves advisory discovery while strict catalogs reject %s",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          if (failure === "offline") {
            throw new Error("Ollama endpoint unavailable");
          }
          return new Response(failure === "invalid-json" ? "{" : "{}", {
            status: typeof failure === "number" ? failure : 200,
          });
        }),
      );

      await expect(buildOllamaProvider(localUrl, { quiet: true })).resolves.toMatchObject({
        models: [],
      });
      await expect(buildOllamaProvider(localUrl, { discoveryMode: "strict" })).rejects.toThrow();
    },
  );
});

describe("buildOllamaBaseUrlSsrFPolicy", () => {
  it.each([
    [localUrl, "127.0.0.1"],
    ["http://192.168.1.10:11434", "192.168.1.10"],
    ["https://ollama.example.com/v1", "ollama.example.com"],
  ])("pins requests to the configured HTTP(S) hostname %s", (url, hostname) => {
    expect(buildOllamaBaseUrlSsrFPolicy(url)).toEqual({
      hostnameAllowlist: [hostname],
      allowPrivateNetwork: true,
    });
  });

  it.each(["", "ftp://ollama.example.com", "not-a-url", "http://metadata.google.internal"])(
    "rejects empty, invalid or blocked base URL %s",
    (url) => {
      expect(buildOllamaBaseUrlSsrFPolicy(url)).toBeUndefined();
    },
  );
});
