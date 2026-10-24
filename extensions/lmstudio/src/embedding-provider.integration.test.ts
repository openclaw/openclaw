import type { IncomingHttpHeaders, RequestListener, ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../../test-support/model-provider-config.test-support.js";
import { createLmstudioEmbeddingProvider } from "./embedding-provider.js";

const MODEL = "embedding-model";
const serverModel = { key: MODEL, type: "embedding", max_context_length: 2048 };
const requireRecord = createRequireRecord("record", "expected-label-object");
const instance = (id: string, context_length: number) => ({ id, config: { context_length } });

beforeEach(() => {
  vi.stubEnv("NO_PROXY", "127.0.0.1");
  vi.stubEnv("no_proxy", "127.0.0.1");
});
afterEach(() => vi.unstubAllEnvs());
function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
function createProvider(
  providerConfig: ModelProviderConfig,
  options: Omit<Partial<Parameters<typeof createLmstudioEmbeddingProvider>[0]>, "config"> = {},
) {
  return createLmstudioEmbeddingProvider({
    provider: "lmstudio",
    model: MODEL,
    fallback: "none",
    config: createModelProviderConfig({ lmstudio: providerConfig }),
    ...options,
  });
}

it.each([
  ["", ""],
  ["?tenant=provider", "?tenant=remote"],
])("isolates provider credentials by destination (%s / %s)", async (providerQuery, remoteQuery) => {
  vi.stubEnv("OPENCLAW_TEST_LMSTUDIO_LITERAL", "ambient-bait");
  vi.stubEnv("OPENCLAW_TEST_LMSTUDIO_PROVIDER", "resolved-provider-value");

  const observedRequests: Array<{ url?: string; headers: IncomingHttpHeaders }> = [];
  const handler: RequestListener = (request, response) => {
    request.resume();
    request.once("end", () => {
      observedRequests.push({ url: request.url, headers: request.headers });
      json(response, { data: [{ index: 0, embedding: [0.25, 0.5, 0.75] }] });
    });
  };

  await withServer(handler, async (origin) => {
    const { provider } = await createProvider(
      {
        baseUrl: `${origin}/v1${providerQuery}`,
        params: { preload: false },
        headers: {
          "X-Provider-Only": "${OPENCLAW_TEST_LMSTUDIO_PROVIDER}",
          "X-Shared": "provider-value",
        },
        models: [],
      },
      {
        remote: {
          baseUrl: `${origin}/v1${remoteQuery}`,
          apiKey: "synthetic-memory-key",
          headers: {
            "X-Already-Resolved": "  ${OPENCLAW_TEST_LMSTUDIO_LITERAL}  ",
            "X-Shared": "  remote-value  ",
            "X-Empty": "   ",
          },
        },
      },
    );

    const result = provider.embed("hello", { inputType: "query" });
    await expect(result).resolves.toEqual([0.25, 0.5, 0.75]);
    expect(observedRequests).toHaveLength(1);
    expect(observedRequests[0]?.url).toBe(`/v1/embeddings${remoteQuery}`);
    const headers = observedRequests[0]?.headers;
    expect(headers).toMatchObject({
      "x-already-resolved": "${OPENCLAW_TEST_LMSTUDIO_LITERAL}",
      "x-shared": "remote-value",
      authorization: "Bearer synthetic-memory-key",
    });
    expect(headers).not.toHaveProperty("x-empty");
    if (!remoteQuery) {
      expect(headers).toHaveProperty("x-provider-only", "${OPENCLAW_TEST_LMSTUDIO_PROVIDER}");
    } else {
      expect(headers).not.toHaveProperty("x-provider-only");
    }
  });
});

it.each(["documents", "queries", "cancelled"] as const)(
  "routes %s embeddings to sufficient-context instances across eviction while holding the service lease",
  async (kind) => {
    let holdLoad = false;
    const loadStarted = createDeferred<void>();
    let loaded = true;
    let instanceNumber = 2;
    let leases = 0;
    const requests: string[] = [];
    const handler: RequestListener = (request, response) => {
      let text = "";
      request.setEncoding("utf8").on("data", (chunk: string) => {
        text += chunk;
      });
      request.once("end", () => {
        requests.push(request.url ?? "");
        expect(leases).toBeGreaterThan(0);
        if (request.url === "/api/v1/models") {
          const loaded_instances = loaded
            ? [instance(MODEL, 1024), instance(`${MODEL}:${instanceNumber}`, 2048)]
            : [];
          json(response, { models: [{ ...serverModel, loaded_instances }] });
        } else if (request.url === "/api/v1/models/load") {
          if (holdLoad) {
            loadStarted.resolve();
            return;
          }
          loaded = true;
          instanceNumber++;
          json(response, { status: "loaded", instance_id: `${MODEL}:${instanceNumber}` });
        } else if (request.url === "/v1/embeddings" && loaded) {
          const body = requireRecord(JSON.parse(text), "embedding request");
          if (!("model" in body) || !Array.isArray(body.input)) {
            throw new Error("Invalid embedding request");
          }
          const embedding = body.model === `${MODEL}:${instanceNumber}` ? [1, 0] : [0, 1];
          json(response, { data: body.input.map((_, index) => ({ index, embedding })) });
        } else {
          json(response, { error: "No models loaded" }, 400);
        }
      });
    };
    await withServer(handler, async (origin) => {
      const { provider, client } = await createProvider(
        {
          baseUrl: `${origin}/v1`,
          localService: { command: "/usr/bin/lms" },
          models: [
            {
              id: MODEL,
              name: "Embedding model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 0,
              contextTokens: 2048,
            },
          ],
        },
        {
          remote: { apiKey: "lmstudio-local" },
          acquireLocalService: async () => {
            leases++;
            return {
              release: () => {
                leases--;
              },
            };
          },
        },
      );
      expect(leases).toBe(0);
      await expect(provider.embed("first")).resolves.toEqual([1, 0]);
      expect(requests).not.toContain("/api/v1/models/load");
      loaded = false;
      requests.length = 0;
      if (kind === "cancelled") {
        holdLoad = true;
        const activeController = new AbortController();
        const active = provider.embed("active", { signal: activeController.signal });
        await loadStarted.promise;
        const queuedController = new AbortController();
        const queued = provider.embed("queued", { signal: queuedController.signal });
        await vi.waitFor(() => expect(leases).toBe(2));
        queuedController.abort(new Error("cancelled while queued"));
        await expect(queued).rejects.toThrow("cancelled while queued");
        expect(leases).toBe(1);
        expect(requests).toEqual(["/api/v1/models", "/api/v1/models/load"]);
        const recovered = provider.embed("recovered");
        holdLoad = false;
        activeController.abort(new Error("cancelled active load"));
        await expect(active).rejects.toThrow("cancelled active load");
        await expect(recovered).resolves.toEqual([1, 0]);
        expect(requests.filter((url) => url === "/v1/embeddings")).toHaveLength(1);
      } else {
        const inputType = kind === "queries" ? "query" : "document";
        await expect(provider.embedBatch(["second", "third"], { inputType })).resolves.toEqual([
          [1, 0],
          [1, 0],
        ]);
      }
      const loadIndex = requests.indexOf("/api/v1/models/load");
      expect(loadIndex).toBeGreaterThanOrEqual(0);
      expect(loadIndex).toBeLessThan(requests.indexOf("/v1/embeddings"));
      expect([leases, provider.model, client.model]).toEqual([0, MODEL, MODEL]);
      requests.length = 0;
      await expect(provider.embedBatch([])).resolves.toEqual([]);
      expect(requests).toEqual([]);
      const aborted = AbortSignal.abort(new Error("cancelled before preload"));
      await expect(provider.embed("cancelled", { signal: aborted })).rejects.toThrow(
        "cancelled before preload",
      );
      expect(requests).toEqual([]);
      expect(leases).toBe(0);
    });
  },
);
