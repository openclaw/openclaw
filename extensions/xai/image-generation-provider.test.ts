import type { IncomingMessage } from "node:http";
import { buffer } from "node:stream/consumers";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, expect, it, vi } from "vitest";
import { createModelProviderConfig } from "../test-support/model-provider-config.test-support.js";
import { buildXaiImageGenerationProvider } from "./image-generation-provider.js";
import { buildXaiVideoGenerationProvider } from "./video-generation-provider.js";

vi.hoisted(() => vi.resetModules());
vi.unmock("openclaw/plugin-sdk/provider-http");
// mock-isolation: Synthetic credentials only; never consult host auth storage.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: async () => ({ apiKey: "test-xai-key" }),
}));
afterAll(() => vi.resetModules());

const media = Buffer.from("generated-media");
type Kind = "image" | "edit" | "video";
type Captured = Pick<IncomingMessage, "url" | "method" | "headers"> & { body: string };
async function generate(kind: Kind, baseUrl: string, allowPrivateNetwork?: boolean) {
  const req = {
    provider: "xai",
    model: kind === "video" ? "grok-imagine-video" : "grok-imagine-image",
    prompt: "transport proof",
    cfg: createModelProviderConfig({
      xai: {
        baseUrl,
        apiKey: "test-xai-key",
        models: [],
        request: { allowPrivateNetwork, headers: { "X-Xai-Trace": "transport-proof" } },
      },
    }),
  };
  return kind === "video"
    ? (await buildXaiVideoGenerationProvider().generateVideo(req)).videos[0]?.buffer
    : (
        await buildXaiImageGenerationProvider().generateImage({
          ...req,
          ...(kind === "edit" ? { inputImages: [{ buffer: media, mimeType: "image/png" }] } : {}),
        })
      ).images[0]?.buffer;
}

async function withXaiServer(
  run: (baseUrl: string, requests: Captured[]) => Promise<void>,
  externalImage?: string,
  redirect = false,
) {
  const requests: Captured[] = [];
  let origin = "";
  await withServer(
    (req, res) => {
      void (async () => {
        requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: (await buffer(req)).toString(),
        });
        if (req.url === "/redirect.png") {
          res.writeHead(302, { Location: externalImage });
          res.end();
        } else if (req.url === "/media/generated.mp4") {
          res.writeHead(200, { "content-type": "video/mp4" });
          res.end(media);
        } else {
          res.setHeader("content-type", "application/json");
          const imageUrl = redirect ? `${origin}/redirect.png` : externalImage;
          const routes: Record<string, unknown> = {
            "/v1/images/generations": {
              data: [imageUrl ? { url: imageUrl } : { b64_json: media.toString("base64") }],
            },
            "/v1/images/edits": { data: [{ b64_json: media.toString("base64") }] },
            "/v1/videos/generations": { request_id: "local_request" },
            "/v1/videos/local_request": {
              status: "done",
              video: { url: `${origin}/media/generated.mp4` },
            },
          };
          res.writeHead(req.url && req.url in routes ? 200 : 404);
          res.end(JSON.stringify(routes[req.url ?? ""]));
        }
      })().catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
    },
    async (url) => {
      origin = url;
      await run(`${url}/v1`, requests);
    },
  );
}

it.each(["image", "edit", "video"] as const)(
  "allows opted-in private %s requests",
  async (kind) => {
    await withXaiServer(async (baseUrl, requests) => {
      expect(await generate(kind, baseUrl, true)).toEqual(media);
      const headers = { authorization: "Bearer test-xai-key" };
      if (kind !== "video") {
        expect(requests).toMatchObject([
          { url: `/v1/images/${kind === "edit" ? "edits" : "generations"}`, headers },
        ]);
        return;
      }
      const videoHeaders = { ...headers, "x-xai-trace": "transport-proof" };
      expect(requests).toMatchObject([
        { method: "POST", url: "/v1/videos/generations", headers: videoHeaders },
        { method: "GET", url: "/v1/videos/local_request", headers: videoHeaders },
        { method: "GET", url: "/media/generated.mp4" },
      ]);
      expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
        model: "grok-imagine-video",
        prompt: "transport proof",
      });
      expect(requests[2]?.headers.authorization).toBeUndefined();
      expect(requests[2]?.headers["x-xai-trace"]).toBeUndefined();
    });
  },
);

it.each([
  ["image", undefined],
  ["image", false],
  ["video", undefined],
  ["video", false],
] as const)("blocks private %s requests with opt-in %s", async (kind, optIn) => {
  await withXaiServer(async (baseUrl, requests) => {
    await expect(generate(kind, baseUrl, optIn)).rejects.toThrow(
      kind === "image"
        ? /private\/internal\/special-use/
        : expect.objectContaining({
            name: "SsrFBlockedError",
            message: expect.stringContaining("private/internal/special-use IP address"),
          }),
    );
    expect(requests).toHaveLength(0);
  });
});

it.each([false, true])(
  "does not authorize another private image origin (redirect: %s)",
  async (redirect) => {
    let downloads = 0;
    await withServer(
      (_req, res) => {
        downloads++;
        res.end(media);
      },
      async (imageBaseUrl) => {
        await withXaiServer(
          async (baseUrl) => {
            await expect(generate("image", baseUrl, true)).rejects.toThrow(
              /private\/internal\/special-use/,
            );
            expect(downloads).toBe(0);
          },
          `${imageBaseUrl}/image.png`,
          redirect,
        );
      },
    );
  },
);
