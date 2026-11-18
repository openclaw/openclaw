import type {
  MemoryEmbeddingProviderCreateOptions,
  MemoryEmbeddingProvider,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";

// Real factories and guarded HTTP share the same loopback probe contract.
export function testEmbeddingNetworkPolicy(params: {
  id: string;
  configId?: string;
  create: (
    options: MemoryEmbeddingProviderCreateOptions,
  ) => Promise<{ provider: MemoryEmbeddingProvider }>;
}) {
  it.each([undefined, false, true])(
    "honors allowPrivateNetwork=%s at HTTP",
    async (allowPrivateNetwork) => {
      const requests: string[] = [];
      await withServer(
        (req, res) => {
          req.resume();
          requests.push(req.url ?? "");
          res.setHeader("content-type", "application/json");
          if (req.url === "/api/v1/models") {
            res.end(
              JSON.stringify({
                models: [
                  {
                    key: "fixture-model",
                    type: "embedding",
                    max_context_length: 2048,
                    loaded_instances: [{ id: "fixture-model", config: { context_length: 2048 } }],
                  },
                ],
              }),
            );
          } else if (req.url?.endsWith(":batchEmbedContents")) {
            res.end(JSON.stringify({ embeddings: [{ values: [1, 0] }] }));
          } else {
            res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
          }
        },
        async (origin) => {
          const { provider } = await params.create({
            config: {
              models: {
                providers: {
                  [params.configId ?? params.id]: {
                    baseUrl: `${origin}/v1`,
                    request: { allowPrivateNetwork },
                    models: [],
                  },
                },
              },
            },
            provider: params.id,
            model: "fixture-model",
            fallback: "none",
            ...(params.id === "lmstudio" ? {} : { remote: { apiKey: "fixture-key" } }),
          });
          if (allowPrivateNetwork === false) {
            const outcome = await provider.embed("hello").then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );
            expect(requests).toEqual([]);
            expect(outcome).toMatchObject({
              error: { message: expect.stringMatching(/private\/internal\/special-use/) },
            });
          } else {
            await expect(provider.embed("hello")).resolves.toEqual([1, 0]);
            expect(requests).toEqual(
              params.id === "lmstudio"
                ? ["/api/v1/models", "/api/v1/models", "/v1/embeddings"]
                : params.id === "gemini"
                  ? ["/v1/models/fixture-model:batchEmbedContents"]
                  : ["/v1/embeddings"],
            );
          }
        },
      );
    },
  );
}
