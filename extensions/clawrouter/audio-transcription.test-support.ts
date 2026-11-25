import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { buffer as consumeBuffer } from "node:stream/consumers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { withServer, withTempHome } from "openclaw/plugin-sdk/test-env";

type Capture = { url: string; authorization?: string; form: FormData };
export async function withClawRouterAudioFixture(
  run: (p: {
    cfg: OpenClawConfig;
    filePath: string;
    requests: Capture[];
    audio: Buffer;
    home: string;
  }) => Promise<void>,
  respond: (res: ServerResponse) => void = (res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ text: "synthetic transcript" }));
  },
) {
  await withTempHome(
    async (home) => {
      const audio = Buffer.alloc(2048, 42);
      audio.write("RIFF", 0);
      audio.writeUInt32LE(2040, 4);
      audio.write("WAVEfmt ", 8);
      audio.writeUInt32LE(16, 16);
      audio.writeUInt16LE(1, 20);
      audio.writeUInt16LE(1, 22);
      audio.writeUInt32LE(8000, 24);
      audio.writeUInt32LE(16000, 28);
      audio.writeUInt16LE(2, 32);
      audio.writeUInt16LE(16, 34);
      audio.write("data", 36);
      audio.writeUInt32LE(2004, 40);
      const filePath = home + "/meeting (1).wav";
      await fs.writeFile(filePath, audio);
      const requests: Capture[] = [];
      await withServer(
        (req, res) => {
          void (async () => {
            const form = await new Response(await consumeBuffer(req), {
              headers: { "content-type": req.headers["content-type"] ?? "" },
            }).formData();
            requests.push({ url: req.url ?? "", authorization: req.headers.authorization, form });
            respond(res);
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
                  apiKey: "fixture-router",
                  request: { allowPrivateNetwork: true },
                  models: [],
                },
              },
            },
            tools: {
              media: {
                models: [{ provider: "clawrouter", capabilities: ["audio"] }],
                audio: { enabled: true },
              },
            },
          };
          await run({ cfg, filePath, requests, audio, home });
        },
      );
    },
    { env: { CLAWROUTER_API_KEY: undefined, OPENAI_API_KEY: "fixture-upstream-never-router" } },
  );
}

export const respondPricingRequired = (res: ServerResponse) => {
  res.statusCode = 400;
  res.end(
    JSON.stringify({
      error: {
        code: "pricing_required",
        message: "No qualified arbitrary-file reserve bound",
      },
    }),
  );
};
