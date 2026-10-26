import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import { buffer as consumeBuffer } from "node:stream/consumers";
import {
  describeImageFile,
  transcribeAudioFile,
} from "openclaw/plugin-sdk/media-understanding-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { withServer, withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { withClawRouterAudioFixture } from "./audio-transcription.test-support.js";

describe("ClawRouter configured media compatibility", () => {
  it.each([
    "explicit image",
    "automatic image",
    "capability-less image",
    "native image",
    "no image capability",
  ] as const)("preserves %s through the registered image runner", async (selection) => {
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
                "data: " +
                  JSON.stringify({
                    id: "fixture",
                    object: "chat.completion.chunk",
                    created: 0,
                    model: "gpt-4.1",
                    choices: [
                      {
                        index: 0,
                        delta: { role: "assistant", content: "synthetic image description" },
                        finish_reason: "stop",
                      },
                    ],
                  }) +
                  "\n\ndata: [DONE]\n\n",
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
                      {
                        id: "gpt-4.1",
                        name: "Fixture vision",
                        reasoning: false,
                        input: selection === "no image capability" ? ["text"] : ["text", "image"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: 8192,
                        maxTokens: 1024,
                      },
                      {
                        id: "fixture-text",
                        name: "Fixture text-only primary",
                        input: ["text"],
                        reasoning: false,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        maxTokens: 1024,
                      },
                    ],
                  },
                },
              },
              tools: {
                media: {
                  image: { enabled: true },
                  ...(selection === "automatic image" ||
                  selection === "native image" ||
                  selection === "no image capability"
                    ? {}
                    : {
                        models: [
                          {
                            provider: "clawrouter",
                            model: "gpt-4.1",
                            ...(selection === "explicit image"
                              ? { capabilities: ["image" as const] }
                              : {}),
                          },
                        ],
                      }),
                },
              },
            };
            const result = await describeImageFile({
              cfg,
              agentDir,
              filePath,
              mime: "image/png",
              activeModel: {
                provider: "clawrouter",
                model: selection === "native image" ? "gpt-4.1" : "fixture-text",
              },
            });
            if (selection === "no image capability") {
              expect(result.text).toBeUndefined();
              expect(result.decision).toMatchObject({ outcome: "skipped" });
              expect(requests.filter(({ url }) => url !== "/v1/catalog")).toHaveLength(0);
              return;
            }
            if (selection === "native image") {
              expect(result.text).toBeUndefined();
              expect(result.decision).toMatchObject({
                outcome: "skipped",
                nativeVisionActive: true,
                attachmentDispositions: { 0: { kind: "handed-to-native-vision" } },
              });
              expect(requests.filter(({ url }) => url !== "/v1/catalog")).toHaveLength(0);
              return;
            }
            expect(result).toMatchObject({
              text: "synthetic image description",
              provider: "clawrouter",
              model: "gpt-4.1",
            });
            const inference = requests.filter(({ url }) => url !== "/v1/catalog");
            expect(inference).toHaveLength(1);
            expect(inference[0]).toMatchObject({
              authorization: "Bearer fixture-router",
              body: { model: "gpt-4.1" },
            });
          },
        );
      },
      { env: { CLAWROUTER_API_KEY: undefined, OPENAI_API_KEY: "fixture-decoy-never-router" } },
    );
  });

  it("keeps a capability-less non-image shared entry out of audio selection", async () => {
    await withClawRouterAudioFixture(async ({ cfg, filePath, requests }) => {
      cfg.tools!.media!.models = [{ provider: "clawrouter", model: "legacy-chat-model" }];
      cfg.plugins!.allow!.push("openai");
      cfg.models!.providers!.openai = {
        baseUrl: cfg.models!.providers!.clawrouter!.baseUrl + "/fallback",
        apiKey: "fixture-fallback",
        request: { allowPrivateNetwork: true },
        models: [],
      };
      delete cfg.models!.providers!.clawrouter!.apiKey;
      const result = await transcribeAudioFile({ cfg, filePath });
      expect(result).toMatchObject({ text: "synthetic transcript", provider: "openai" });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: "/fallback/audio/transcriptions",
        authorization: "Bearer fixture-fallback",
      });
    });
  });
});
