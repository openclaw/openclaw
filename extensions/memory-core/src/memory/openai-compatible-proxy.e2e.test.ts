import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";

it("routes the deep memory probe through the environment proxy", async () => {
  await withOpenClawTestState({ applyEnv: false }, async (state) => {
    await using proxy = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }));
    });
    const authorities: string[] = [];
    using connections = new DisposableStack();
    proxy.on("connect", (request, clientSocket, head) => {
      authorities.push(request.url ?? "");
      connections.defer(() => clientSocket.destroy());
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      // Terminate the synthetic origin here, using a fresh HTTP parser for the tunnel.
      proxy.emit("connection", clientSocket);
      clientSocket.unshift(head);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const address = proxy.address();
    assert(address && typeof address !== "string");

    const remote = { baseUrl: "http://embeddings.example.test/v1", apiKey: "proof-key" };
    const search = { provider: "openai-compatible", model: "proxy-proof-model", remote };
    const config = { memory: { search }, plugins: { slots: { memory: "memory-core" } } };
    await state.writeConfig(config);

    const result = await promisify(execFile)(
      process.execPath,
      ["openclaw.mjs", "memory", "status", "--deep", "--agent", "main"],
      {
        encoding: "utf8",
        env: {
          ...state.env,
          HTTP_PROXY: `http://127.0.0.1:${address.port}`,
          http_proxy: `http://127.0.0.1:${address.port}`,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_ENV: undefined,
          NODE_OPTIONS: undefined,
          NO_COLOR: "1",
          NO_PROXY: "",
          no_proxy: "",
          OPENCLAW_NO_RESPAWN: "1",
          VITEST: undefined,
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 90_000,
      },
    );

    expect(result.stdout).toContain("Embeddings: ready");
    expect(authorities).toEqual(["embeddings.example.test:80"]);
  });
}, 120_000);
