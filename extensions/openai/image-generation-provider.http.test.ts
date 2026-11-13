import { json as readJsonRequest } from "node:stream/consumers";
import {
  ensureAuthProfileStoreAsync,
  isProviderApiKeyConfiguredAsync,
  listProfilesForProvider,
} from "openclaw/plugin-sdk/provider-auth";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import {
  createCodexOAuthAuthStore,
  openAIImageConfig,
} from "./image-generation-provider.test-support.js";

// Fix only external credential lookup; provider routing and HTTP execution stay real.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: async () => ({
    apiKey: "synthetic-image-oauth",
    mode: "oauth",
    source: "profile:openai:default",
  }),
}));

it.each([true, false])(
  "sends Sol and the image model over HTTP without an implicit fallback (accepted: %s)",
  async (accepted) => {
    const provider = buildOpenAIImageGenerationProvider({
      ensureAuthProfileStoreAsync,
      listProfilesForProvider,
      isProviderApiKeyConfiguredAsync,
    });
    const requests: unknown[] = [];
    await withServer(
      (request, response) => {
        void readJsonRequest(request)
          .then((body: unknown) => {
            requests.push(body);
            if (!accepted) {
              response.writeHead(400, { "Content-Type": "application/json" });
              response.end(
                JSON.stringify({
                  detail:
                    "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
                }),
              );
              return;
            }
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.end(
              "data: " +
                JSON.stringify({
                  type: "response.completed",
                  response: {
                    output: [
                      {
                        type: "image_generation_call",
                        status: "completed",
                        result: Buffer.from("fixture-image").toString("base64"),
                      },
                    ],
                  },
                }) +
                "\n\n",
            );
          })
          .catch((error: unknown) => {
            response.destroy(error instanceof Error ? error : undefined);
          });
      },
      async (origin) => {
        const pending = provider.generateImage({
          provider: "openai",
          model: "gpt-image-2",
          prompt: "Draw a lighthouse",
          authStore: createCodexOAuthAuthStore(),
          cfg: openAIImageConfig({
            baseUrl: origin + "/backend-api/codex",
            api: "openai-chatgpt-responses",
            request: { allowPrivateNetwork: true },
          }),
        });
        if (accepted) {
          expect((await pending).images).toHaveLength(1);
        } else {
          await expect(pending).rejects.toThrow("not supported when using Codex");
        }
        expect(requests).toEqual([
          expect.objectContaining({
            model: "gpt-6.1-sol",
            tools: [expect.objectContaining({ type: "image_generation", model: "gpt-image-2" })],
          }),
        ]);
      },
    );
  },
);
