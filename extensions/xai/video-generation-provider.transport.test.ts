import type { IncomingMessage } from "node:http";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildXaiVideoGenerationProvider } from "./video-generation-provider.js";

vi.hoisted(() => vi.resetModules());
vi.unmock("openclaw/plugin-sdk/provider-http");

afterAll(() => vi.resetModules());

type CapturedRequest = {
  body: string;
  headers: IncomingMessage["headers"];
  method?: string;
  url?: string;
};

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function withXaiVideoServer(
  run: (server: { baseUrl: string; requests: CapturedRequest[] }) => Promise<void>,
) {
  const requests: CapturedRequest[] = [];
  let videoUrl = "";
  await withServer(
    (request, response) => {
      void (async () => {
        requests.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: await readRequestBody(request),
        });
        const routes: Record<string, string | Buffer> = {
          "POST /v1/videos/generations": JSON.stringify({ request_id: "local_request" }),
          "GET /v1/videos/local_request": JSON.stringify({
            request_id: "local_request",
            status: "done",
            video: { url: videoUrl },
          }),
          "GET /media/generated.mp4": Buffer.from("mp4"),
        };
        const body = routes[`${request.method} ${request.url}`];
        response.writeHead(body === undefined ? 404 : 200, {
          "content-type": Buffer.isBuffer(body) ? "video/mp4" : "application/json",
        });
        response.end(body ?? "not found");
      })().catch((error: unknown) => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(error instanceof Error ? error.message : String(error));
      });
    },
    async (origin) => {
      videoUrl = `${origin}/media/generated.mp4`;
      await run({ baseUrl: `${origin}/v1`, requests });
    },
  );
}

function generate(baseUrl: string, request?: Record<string, unknown>, prompt = "transport proof") {
  return buildXaiVideoGenerationProvider().generateVideo({
    provider: "xai",
    model: "grok-imagine-video",
    prompt,
    cfg: {
      models: {
        providers: { xai: { baseUrl, apiKey: "local-xai-key", ...(request ? { request } : {}) } },
      },
    } as never,
  });
}

describe("xai video generation provider transport", () => {
  it("uses configured policy for xAI API requests without leaking headers to video downloads", async () => {
    await withXaiVideoServer(async (server) => {
      const result = await generate(server.baseUrl, {
        allowPrivateNetwork: true,
        headers: { "X-Xai-Trace": "transport-proof" },
      });

      expect(result.videos[0]?.buffer).toEqual(Buffer.from("mp4"));
      const apiHeaders = {
        authorization: "Bearer local-xai-key",
        "x-xai-trace": "transport-proof",
      };
      expect(server.requests).toMatchObject([
        { method: "POST", url: "/v1/videos/generations", headers: apiHeaders },
        { method: "GET", url: "/v1/videos/local_request", headers: apiHeaders },
        { method: "GET", url: "/media/generated.mp4" },
      ]);
      expect(JSON.parse(server.requests[0]?.body ?? "{}")).toMatchObject({
        model: "grok-imagine-video",
        prompt: "transport proof",
      });
      expect(server.requests[2]?.headers.authorization).toBeUndefined();
      expect(server.requests[2]?.headers["x-xai-trace"]).toBeUndefined();
    });
  });

  it.each([
    ["default", undefined],
    ["explicit false", { allowPrivateNetwork: false }],
  ] as const)(
    "blocks %s loopback xAI video requests before reaching the server",
    async (policyName, requestPolicy) => {
      await withXaiVideoServer(async (server) => {
        await expect(
          generate(server.baseUrl, requestPolicy, `${policyName} policy loopback proof`),
        ).rejects.toThrow(
          expect.objectContaining({
            name: "SsrFBlockedError",
            message: expect.stringContaining("private/internal/special-use IP address"),
          }),
        );

        expect(server.requests).toHaveLength(0);
      });
    },
  );
});
