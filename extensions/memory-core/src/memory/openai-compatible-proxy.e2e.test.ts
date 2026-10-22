import { execFile } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { text } from "node:stream/consumers";
import { promisify } from "node:util";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const execFileAsync = promisify(execFile);

async function listen(server: Server): Promise<number> {
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not expose a TCP address");
  }
  return address.port;
}

it("routes a deep memory status probe through the OpenAI-compatible environment proxy", async () => {
  const requests: Array<Record<string, unknown>> = [];
  await using endpoint = createServer((request, response) => {
    void (async () => {
      requests.push(JSON.parse(await text(request)) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }));
    })();
  });
  const endpointPort = await listen(endpoint);

  const authorities: string[] = [];
  await using proxy = createServer();
  using connections = {
    sockets: new Set<Duplex>(),
    [Symbol.dispose]() {
      this.sockets.forEach((socket) => socket.destroy());
    },
  };
  proxy.on("connect", (request, clientSocket, head) => {
    authorities.push(request.url ?? "");
    const targetSocket = connect(endpointPort, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      targetSocket.write(head);
      clientSocket.pipe(targetSocket).pipe(clientSocket);
    });
    for (const socket of [clientSocket, targetSocket]) {
      connections.sockets.add(socket);
      socket.on("close", () => connections.sockets.delete(socket));
    }
  });
  const proxyPort = await listen(proxy);

  const root = tempDirs.make("openclaw-memory-proxy-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.mkdir(stateDir, { recursive: true });
  const remote = {
    baseUrl: `http://embeddings.example.test:${endpointPort}/v1`,
    apiKey: "proof-key",
  };
  const search = { provider: "openai-compatible", model: "proxy-proof-model", remote };
  const config = { memory: { search }, plugins: { slots: { memory: "memory-core" } } };
  await fs.writeFile(configPath, JSON.stringify(config));

  const result = await execFileAsync(
    process.execPath,
    [path.resolve("openclaw.mjs"), "memory", "status", "--deep", "--agent", "main"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        http_proxy: `http://127.0.0.1:${proxyPort}`,
        NODE_DISABLE_COMPILE_CACHE: "1",
        NODE_ENV: undefined,
        NODE_OPTIONS: undefined,
        NO_COLOR: "1",
        NO_PROXY: "",
        no_proxy: "",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_STATE_DIR: stateDir,
        USERPROFILE: root,
        VITEST: undefined,
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 90_000,
    },
  );

  expect(result.stdout).toContain("Embeddings: ready");
  expect(authorities).toEqual([`embeddings.example.test:${endpointPort}`]);
  expect(requests).toEqual([
    expect.objectContaining({ model: "proxy-proof-model", input: ["ping"] }),
  ]);
}, 120_000);
