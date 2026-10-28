import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import { buffer as consumeBuffer } from "node:stream/consumers";
import { describeImageFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { withServer, withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";

function imageModel(id: string, input: Array<"text" | "image">) {
  return {
    id,
    name: id,
    input,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 1024,
  };
}

it.each(["explicit image", "automatic image", "capability-less image"] as const)(
  "preserves %s through the registered image runner",
  async (selection) => {
    await withTempHome(
      async (home) => {
        const image = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64",
        );
        const filePath = home + "/fixture.png";
        const agentDir = home + "/agent";
        await fs.mkdir(agentDir);
        await fs.writeFile(filePath, image);
        const requests: Array<{ url?: string; authorization?: string; body: unknown }> = [];
        await withServer(
          (req, res) => {
            void (async () => {
              const body = (await consumeBuffer(req)).toString();
              requests.push({
                url: req.url,
                authorization: req.headers.authorization,
                body: body ? JSON.parse(body) : undefined,
              });
              if (req.url === "/v1/catalog") {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ providers: [] }));
                return;
              }
              res.setHeader("content-type", "text/event-stream");
              res.end(
                'data: {"id":"fixture","object":"chat.completion.chunk","created":0,"model":"gpt-4.1","choices":[{"index":0,"delta":{"role":"assistant","content":"synthetic image description"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              );
            })().catch((error: unknown) =>
              res.destroy(error instanceof Error ? error : new Error(String(error))),
            );
          },
          async (baseUrl) => {
            const cfg: OpenClawConfig = {
              plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
              models: {
                providers: {
                  clawrouter: {
                    baseUrl,
                    api: "openai-completions",
                    apiKey: "fixture-router",
                    request: { allowPrivateNetwork: true },
                    models: [
                      imageModel("gpt-4.1", ["text", "image"]),
                      imageModel("fixture-text", ["text"]),
                    ],
                  },
                },
              },
              tools: {
                media: {
                  image: { enabled: true },
                  models:
                    selection === "explicit image" || selection === "capability-less image"
                      ? [
                          {
                            provider: "clawrouter",
                            model: "gpt-4.1",
                            ...(selection === "explicit image" ? { capabilities: ["image"] } : {}),
                          },
                        ]
                      : undefined,
                },
              },
            };
            const result = await describeImageFile({
              cfg,
              agentDir,
              filePath,
              mime: "image/png",
              activeModel: { provider: "clawrouter", model: "fixture-text" },
            });
            expect(result).toMatchObject({
              text: "synthetic image description",
              provider: "clawrouter",
              model: "gpt-4.1",
            });
            expect(requests.filter(({ url }) => url !== "/v1/catalog")).toEqual([
              expect.objectContaining({
                authorization: "Bearer fixture-router",
                body: expect.objectContaining({ model: "gpt-4.1" }),
              }),
            ]);
          },
        );
      },
      { env: { CLAWROUTER_API_KEY: undefined, OPENAI_API_KEY: "fixture-decoy-never-router" } },
    );
  },
);
