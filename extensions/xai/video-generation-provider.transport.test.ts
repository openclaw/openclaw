import type { IncomingMessage, ServerResponse } from "node:http";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildXaiVideoGenerationProvider } from "./video-generation-provider.js";

vi.hoisted(() => vi.resetModules());
vi.unmock("openclaw/plugin-sdk/provider-http");

const resolveApiKeyForProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    apiKey: "local-xai-key",
    source: "profile",
    mode: "api-key",
  })),
);

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/provider-auth-runtime");
  vi.resetModules();
});

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

function writeJson(response: ServerResponse, payload: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
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
        if (request.method === "POST" && request.url === "/v1/videos/generations") {
          writeJson(response, { request_id: "local_request" });
          return;
        }
        if (request.method === "GET" && request.url === "/v1/videos/local_request") {
          writeJson(response, {
            request_id: "local_request",
            status: "done",
            video: { url: videoUrl },
          });
          return;
        }
        if (request.method === "GET" && request.url === "/media/generated.mp4") {
          response.writeHead(200, { "content-type": "video/mp4" });
          response.end(Buffer.from("mp4"));
          return;
        }
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
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
      models: { providers: { xai: { baseUrl, ...(request ? { request } : {}) } } },
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
