import { expect, it } from "vitest";
import { verifyStartupArtifact } from "./attempt-runtime-artifact.js";
import { createWebSocketPeer } from "./client-websocket.test-support.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { readCodexAppServerClientRuntimeArtifact } from "./runtime-artifact.js";
import { createIsolatedCodexAppServerClient as createClient } from "./shared-client.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

export function registerSharedClientConnectionArtifactTests(): void {
  it.each(["binding reuse", "identity change"] as const)(
    "verifies isolated remote inference: %s",
    async (mode) => {
      await withRemoteServer(async ({ startOptions, clients, changeHome, requests }) => {
        const verify = (
          client: CodexAppServerClient,
          request: Parameters<typeof verifyStartupArtifact>[0]["request"] = {},
        ) =>
          verifyStartupArtifact({
            client,
            request,
            startOptions,
            signal: new AbortController().signal,
          });
        const probe = await createClient({ startOptions, runtimeArtifactMode: "capture" });
        clients.push(probe);
        const expected =
          mode === "binding reuse"
            ? await verify(probe)
            : readCodexAppServerClientRuntimeArtifact(probe);
        if (!expected) {
          throw new Error("expected verified remote runtime");
        }
        await probe.closeAndWait();
        const reconnect = () => createClient({ startOptions, expectedRuntimeArtifact: expected });
        if (mode === "identity change") {
          changeHome();
          await expect(reconnect()).rejects.toThrow(
            "runtime artifact does not match verified inference",
          );
          expect(requests).toEqual(["initialize", "initialize"]);
        } else {
          expect(expected).toEqual({
            id: expect.stringMatching(/^codex-app-server:connection:v1:/u),
            fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          });
          const expert = await reconnect();
          clients.push(expert);
          await expect(verify(expert, { expected })).resolves.toEqual(expected);
        }
      });
    },
  );
}

async function withRemoteServer(
  run: (fixture: {
    startOptions: CodexAppServerStartOptions;
    clients: CodexAppServerClient[];
    requests: string[];
    changeHome: () => void;
  }) => Promise<void>,
): Promise<void> {
  const clients: CodexAppServerClient[] = [];
  const requests: string[] = [];
  const result = {
    userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}`,
    codexHome: "/remote/codex-home",
    platformFamily: "unix",
    platformOs: "linux",
  };
  const peer = await createWebSocketPeer((request, respond) => {
    if (request.id === undefined) {
      return;
    }
    requests.push(request.method);
    if (request.method === "initialize") {
      respond(result);
    }
  });
  try {
    await run({
      startOptions: {
        transport: "websocket",
        command: "codex",
        args: [],
        headers: {},
        url: peer.url,
      },
      clients,
      requests,
      changeHome: () => {
        result.codexHome = "/remote/changed-home";
      },
    });
  } finally {
    await Promise.all(clients.map((client) => client.closeAndWait()));
    await peer.close();
  }
}
