import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { verifyStartupArtifact } from "./attempt-runtime-artifact.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { readCodexAppServerClientRuntimeArtifact } from "./runtime-artifact.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

/** Uses the suite's auth fixture but real socket startup and verification owners. */
export function registerSharedClientConnectionArtifactTests(): void {
  it("verifies isolated remote inference and reuses its binding on a fresh connection", async () => {
    await withRemoteServer(async ({ startOptions, clients }) => {
      const probe = await createIsolatedCodexAppServerClient({
        startOptions,
        runtimeArtifactMode: "capture",
      });
      clients.push(probe);
      const expected = await verifyStartupArtifact({
        client: probe,
        request: {},
        startOptions,
        signal: new AbortController().signal,
      });
      expect(expected).toEqual({
        id: expect.stringMatching(/^codex-app-server:connection:v1:/u),
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      await probe.closeAndWait();
      const expert = await createIsolatedCodexAppServerClient({
        startOptions,
        expectedRuntimeArtifact: expected,
      });
      clients.push(expert);
      await expect(
        verifyStartupArtifact({
          client: expert,
          request: { expected },
          startOptions,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual(expected);
    });
  });

  it("rejects a remote identity change before issuing a native thread request", async () => {
    await withRemoteServer(async ({ startOptions, clients, changeHome, requests }) => {
      const probe = await createIsolatedCodexAppServerClient({
        startOptions,
        runtimeArtifactMode: "capture",
      });
      clients.push(probe);
      const expectedRuntimeArtifact = readCodexAppServerClientRuntimeArtifact(probe);
      if (!expectedRuntimeArtifact) {
        throw new Error("expected verified remote runtime");
      }
      await probe.closeAndWait();
      changeHome();
      await expect(
        createIsolatedCodexAppServerClient({ startOptions, expectedRuntimeArtifact }),
      ).rejects.toThrow("runtime artifact does not match verified inference");
      expect(requests).toEqual(["initialize", "initialize"]);
    });
  });
}

async function withRemoteServer(
  run: (fixture: {
    startOptions: CodexAppServerStartOptions;
    clients: CodexAppServerClient[];
    requests: string[];
    changeHome: () => void;
  }) => Promise<void>,
): Promise<void> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const clients: CodexAppServerClient[] = [];
  const requests: string[] = [];
  let codexHome = "/remote/codex-home";
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      const request = JSON.parse(bytes.toString("utf8")) as { id?: number; method: string };
      if (request.id === undefined) {
        return;
      }
      requests.push(request.method);
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}`,
              codexHome,
              platformFamily: "unix",
              platformOs: "linux",
            },
          }),
        );
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected remote Codex fixture port");
    }
    await run({
      startOptions: {
        transport: "websocket",
        command: "codex",
        args: [],
        headers: {},
        url: `ws://127.0.0.1:${address.port}`,
      },
      clients,
      requests,
      changeHome: () => {
        codexHome = "/remote/changed-home";
      },
    });
  } finally {
    await Promise.all(clients.map((client) => client.closeAndWait()));
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
