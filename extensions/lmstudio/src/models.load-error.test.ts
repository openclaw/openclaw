import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { ensureLmstudioModelLoaded } from "./models.fetch.js";

describe("LM Studio model-load error transport", () => {
  it("redacts actual outbound credentials reflected by a model-load HTTP server", async () => {
    let responseStatus = 502;
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            models: [{ type: "llm", key: "qwen3-8b-instruct", loaded_instances: [] }],
          }),
        );
        return;
      }
      const authorization = request.headers.authorization;
      const proxyAuthorization = request.headers["x-proxy-auth"];
      if (typeof authorization !== "string" || typeof proxyAuthorization !== "string") {
        response.writeHead(500);
        response.end("missing expected authentication headers");
        return;
      }
      const reflected = `upstream rejected ${authorization}; proxy ${proxyAuthorization}`;
      response.writeHead(responseStatus, { "Content-Type": "application/json" });
      response.end(responseStatus === 200 ? JSON.stringify({ status: reflected }) : reflected);
    });
    const port = await listenOnLoopback(server);
    try {
      for (const [status, expected] of [
        [502, "LM Studio model load failed (502): upstream rejected ***; proxy ***"],
        [200, "LM Studio model load returned unexpected status: upstream rejected ***; proxy ***"],
      ] as const) {
        responseStatus = status;
        await expect(
          ensureLmstudioModelLoaded({
            baseUrl: `http://127.0.0.1:${port}`,
            modelKey: "qwen3-8b-instruct",
            apiKey: "sk-test",
            headers: { "X-Proxy-Auth": "opaque-short" },
          }),
        ).rejects.toThrow(expected);
      }
    } finally {
      await server[Symbol.asyncDispose]();
    }
  });
});
