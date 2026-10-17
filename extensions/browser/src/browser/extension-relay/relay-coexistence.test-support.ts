import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { acquireTestPortBlock, withEnvAsync, withTempDir } from "openclaw/plugin-sdk/test-env";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { expect } from "vitest";
import { relayTestKey } from "../../../chrome-extension/relay-key.test-support.js";
import { stopBrowserControlService } from "../../control-service.js";
import { runExtensionRelayDaemon } from "../relay-daemon.js";
import {
  createRelayProof,
  randomRelayNonce,
  relayKeyIdFromHex,
  verifyRelayProof,
  type BrowserRelayAuthChallenge,
} from "./auth-v2-crypto.js";
import {
  BROWSER_RELAY_EXTENSION_SUBPROTOCOL,
  BROWSER_RELAY_AUTH_CHALLENGE_PATH,
  BROWSER_RELAY_AUTH_COMPLETE_PATH,
} from "./auth-v2.js";
import { RawHttpConnection } from "./relay-http.test-support.js";

const INITIAL_PORT_SELECTION_ATTEMPTS = 3;
const FIXTURE_TAB = {
  tabId: 1,
  url: "https://example.com/fixture",
  title: "Fixture",
  active: true,
};

export async function authenticateExtension(
  extension: WebSocket,
  token: string,
  okTimeoutMs?: number,
) {
  const challengeMessage = once(extension, "message");
  extension.send(
    JSON.stringify({
      type: "auth.hello",
      v: 2,
      keyId: relayKeyIdFromHex(token),
      clientNonce: randomRelayNonce(),
    }),
  );
  const [raw] = await challengeMessage;
  const challenge = JSON.parse(rawDataToString(raw));
  const authenticated = once(extension, "message", {
    signal: okTimeoutMs === undefined ? undefined : AbortSignal.timeout(okTimeoutMs),
  });
  extension.send(
    JSON.stringify({
      type: "auth.response",
      v: 2,
      sessionId: challenge.sessionId,
      clientProof: createRelayProof(token, "client", challenge),
    }),
  );
  const [ok] = await authenticated;
  expect(JSON.parse(rawDataToString(ok))).toMatchObject({ type: "auth.ok", v: 2 });
}

/** An ordinary external v2 client: HTTP authentication/discovery/upgrade on one socket. */
export async function externalRelayClient(port: number, token: string): Promise<WebSocket> {
  const connection = await RawHttpConnection.connect(port);
  const request = async (pathname: string, body?: unknown) => {
    const response = await connection.request(
      body === undefined ? "GET" : "POST",
      pathname,
      body === undefined ? "" : JSON.stringify(body),
      { "Content-Type": "application/json" },
    );
    expect(response.status).toBe(200);
    return response.body;
  };
  try {
    const challenge = JSON.parse(
      await request(BROWSER_RELAY_AUTH_CHALLENGE_PATH, {
        v: 2,
        keyId: relayKeyIdFromHex(token),
        clientNonce: randomRelayNonce(),
        role: "cdp",
        transport: "connection",
        method: "SEQUENCE",
        resource: "/json/version -> /cdp",
        flow: "cdp",
      }),
    ) as BrowserRelayAuthChallenge;
    expect(verifyRelayProof(token, "server", challenge, challenge.serverProof)).toBe(true);
    const clientProof = createRelayProof(token, "client", challenge);
    const accepted = JSON.parse(
      await request(BROWSER_RELAY_AUTH_COMPLETE_PATH, {
        v: 2,
        sessionId: challenge.sessionId,
        clientProof,
      }),
    ) as { acceptProof: string };
    expect(verifyRelayProof(token, "accept", challenge, accepted.acceptProof, clientProof)).toBe(
      true,
    );
    await request("/json/version");
    const authenticated = connection.takeSocket();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      createConnection: () => authenticated,
    });
    await once(ws, "open").catch((error: unknown) => {
      throw new Error("External relay upgrade failed", { cause: error });
    });
    return ws;
  } catch (error) {
    connection.close();
    throw error;
  }
}

export async function externalVersion(ws: WebSocket): Promise<unknown> {
  const response = once(ws, "message");
  ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
  const [raw] = await response;
  return JSON.parse(rawDataToString(raw));
}

export async function withConnectedDaemon(
  run: (fixture: {
    port: number;
    token: string;
    extension: WebSocket;
    stateDir: string;
    setTarget: (value: string) => void;
    sendTabs: (granted: boolean) => void;
    holdDetach: () => { entered: Promise<void>; release: () => void };
    restartDaemon: () => Promise<void>;
  }) => Promise<void>,
  startDaemon?: (
    port: number,
    stateDir: string,
    config: object,
  ) => Promise<{ port: number | null; stop: () => void; done: Promise<unknown> }>,
  handleExtensionCommand?: (
    command: Record<string, unknown>,
    send: (message: Record<string, unknown>) => void,
  ) => boolean,
) {
  let portClaim: Awaited<ReturnType<typeof acquireTestPortBlock>> | undefined =
    await acquireTestPortBlock({ offsets: [0] });
  const releasePortClaim = async () => {
    const claim = portClaim;
    portClaim = undefined;
    await claim?.release();
  };
  try {
    await withTempDir("relay-coexistence-", async (dir) => {
      const stateDir = await fs.realpath(dir);
      const credentials = path.join(stateDir, "credentials");
      const token = relayTestKey(9);
      await fs.mkdir(credentials);
      await fs.writeFile(path.join(credentials, "browser-extension-relay.secret"), token, {
        mode: 0o600,
      });
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_OAUTH_DIR: credentials },
        async () => {
          const start = async (mayReselectPort = false) => {
            const attempts = mayReselectPort ? INITIAL_PORT_SELECTION_ATTEMPTS : 1;
            for (let attempt = 1; attempt <= attempts; attempt += 1) {
              portClaim ??= await acquireTestPortBlock({ offsets: [0] });
              const port = portClaim.port;
              const config = {
                gateway: { auth: { mode: "token" as const, token: "coexistence-test" } },
                browser: {
                  profiles: { chrome: { driver: "extension" as const, cdpPort: port } },
                },
              };
              setRuntimeConfigSnapshot(config, config);
              const started = startDaemon
                ? await startDaemon(port, stateDir, config)
                : await runExtensionRelayDaemon({ port });
              if (started.port === port) {
                return { daemon: started, port };
              }
              started.stop();
              const reason = await started.done;
              if (reason === "port-in-use" && attempt < attempts) {
                await releasePortClaim();
                continue;
              }
              throw new Error(
                `Relay fixture startup failed: expected port ${port}, got ${started.port ?? "no listener"} (${String(reason)})`,
              );
            }
            throw new Error("Relay fixture exhausted its initial port selections");
          };
          const started = await start(true);
          const port = started.port;
          let daemon = started.daemon;
          const extension = new WebSocket(
            `ws://127.0.0.1:${port}/extension`,
            BROWSER_RELAY_EXTENSION_SUBPROTOCOL,
            { origin: "chrome-extension://coexistence-test" },
          );
          const send = (message: Record<string, unknown>) =>
            extension.send(JSON.stringify(message));
          let nativeTarget = "fixture-target";
          let detachHeld = false;
          let detachEntered = () => {};
          const detachReplies: Array<() => void> = [];
          try {
            await once(extension, "open");
            await authenticateExtension(extension, token);
            extension.on("message", (frame) => {
              const command = JSON.parse(rawDataToString(frame)) as {
                seq: number;
                type: string;
                method?: string;
              };
              if (command.type === "ping") {
                send({ type: "pong" });
                return;
              }
              if (handleExtensionCommand?.(command, send)) {
                return;
              }
              if (command.type === "detach" && detachHeld) {
                detachReplies.push(() => send({ type: "result", seq: command.seq, result: {} }));
                detachEntered();
                return;
              }
              const result =
                command.type === "attach"
                  ? { targetId: nativeTarget }
                  : command.method === "Target.getTargetInfo"
                    ? {
                        targetInfo: {
                          targetId: nativeTarget,
                          title: FIXTURE_TAB.title,
                          type: "page",
                          url: FIXTURE_TAB.url,
                        },
                      }
                    : command.method === "Page.getFrameTree"
                      ? {
                          frameTree: {
                            frame: {
                              id: nativeTarget,
                              name: "",
                              loaderId: "loader",
                              url: FIXTURE_TAB.url,
                              securityOrigin: "https://example.com",
                              mimeType: "text/html",
                            },
                          },
                        }
                      : {};
              send({ type: "result", seq: command.seq, result });
            });
            send({
              type: "hello",
              browserVersion: "Chrome/test",
              userAgent: "coexistence-test",
              extensionVersion: "2",
              tabs: [FIXTURE_TAB],
            });

            await run({
              port,
              token,
              extension,
              stateDir,
              restartDaemon: async () => {
                daemon.stop();
                await daemon.done;
                daemon = (await start()).daemon;
              },
              holdDetach: () => {
                detachHeld = true;
                const entered = new Promise<void>((resolve) => {
                  detachEntered = resolve;
                });
                return {
                  entered,
                  release: () => {
                    detachHeld = false;
                    for (const reply of detachReplies.splice(0)) {
                      reply();
                    }
                  },
                };
              },
              setTarget: (value) => {
                nativeTarget = value;
              },
              sendTabs: (granted) => send({ type: "tabs", tabs: granted ? [FIXTURE_TAB] : [] }),
            });
          } finally {
            try {
              await stopBrowserControlService();
            } finally {
              extension.terminate();
              daemon.stop();
              await daemon.done;
            }
          }
        },
      );
    });
  } finally {
    await releasePortClaim();
  }
}
