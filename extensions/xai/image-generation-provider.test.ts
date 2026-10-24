import type { ImageGenerationRequest } from "openclaw/plugin-sdk/image-generation";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { buildXaiImageGenerationProvider } from "./image-generation-provider.js";

// mock-isolation: Use a synthetic credential without reading host auth storage.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: async () => ({ apiKey: "test-xai-key" }),
}));

const image = Buffer.from("generated-image");
const provider = buildXaiImageGenerationProvider();

function request(baseUrl: string, allowPrivateNetwork?: boolean): ImageGenerationRequest {
  return {
    provider: "xai",
    model: "grok-imagine-image",
    prompt: "A lobster",
    cfg: {
      models: {
        providers: {
          xai: {
            baseUrl,
            models: [],
            request: { allowPrivateNetwork },
          },
        },
      },
    },
  };
}

describe("xAI image generation private endpoints", () => {
  it.each([undefined, false])("blocks a private endpoint with opt-in %s", async (optIn) => {
    let requests = 0;
    await withServer(
      (_req, res) => {
        requests++;
        res.end();
      },
      async (baseUrl) => {
        await expect(provider.generateImage(request(baseUrl, optIn))).rejects.toThrow(
          /private\/internal\/special-use/,
        );
        expect(requests).toBe(0);
      },
    );
  });

  it.each(["generations", "edits"])("allows opted-in private image %s", async (endpoint) => {
    const paths: string[] = [];
    await withServer(
      (req, res) => {
        paths.push(req.url ?? "");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }));
      },
      async (baseUrl) => {
        const req = request(baseUrl, true);
        if (endpoint === "edits") {
          req.inputImages = [{ buffer: image, mimeType: "image/png" }];
        }
        const result = await provider.generateImage(req);
        expect(result.images[0]?.buffer).toEqual(image);
        expect(paths).toEqual([`/images/${endpoint}`]);
      },
    );
  });

  it.each([false, true])(
    "does not authorize another private image origin (redirect: %s)",
    async (redirect) => {
      let downloads = 0;
      await withServer(
        (_req, res) => {
          downloads++;
          res.end(image);
        },
        async (imageBaseUrl) => {
          let imageUrl = `${imageBaseUrl}/image.png`;
          await withServer(
            (req, res) => {
              if (req.url === "/redirect.png") {
                res.writeHead(302, { Location: `${imageBaseUrl}/image.png` });
                res.end();
                return;
              }
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ data: [{ url: imageUrl }] }));
            },
            async (baseUrl) => {
              if (redirect) {
                imageUrl = `${baseUrl}/redirect.png`;
              }
              await expect(provider.generateImage(request(baseUrl, true))).rejects.toThrow(
                /private\/internal\/special-use/,
              );
              expect(downloads).toBe(0);
            },
          );
        },
      );
    },
  );
});
