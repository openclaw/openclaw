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

const FIXTURE_TAB = {
  tabId: 1,
  url: "https://example.com/fixture",
  title: "Fixture",
  active: true,
};
const { title, url } = FIXTURE_TAB;
const FRAME = { name: "", loaderId: "loader", url };

async function exchange(extension: WebSocket, message: object, timeoutMs?: number) {
  const received = once(extension, "message", {
    signal: timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs),
  });
  extension.send(JSON.stringify(message));
  const [raw] = await received;
  return JSON.parse(rawDataToString(raw));
}

export async function authenticateExtension(
  extension: WebSocket,
  token: string,
  okTimeoutMs?: number,
) {
  const challenge = await exchange(extension, {
    type: "auth.hello",
    v: 2,
    keyId: relayKeyIdFromHex(token),
    clientNonce: randomRelayNonce(),
  });
  const ok = await exchange(
    extension,
    {
      type: "auth.response",
      v: 2,
      sessionId: challenge.sessionId,
      clientProof: createRelayProof(token, "client", challenge),
    },
    okTimeoutMs,
  );
  expect(ok).toMatchObject({ type: "auth.ok", v: 2 });
}

export async function authenticateRelayHttp(
  connection: RawHttpConnection,
  token: string,
  flow: "cdp" | "json-list",
) {
  const request = async (pathname: string, body?: unknown): Promise<unknown> => {
    const response = await connection.request(
      body === undefined ? "GET" : "POST",
      pathname,
      body === undefined ? "" : JSON.stringify(body),
      { "Content-Type": "application/json" },
    );
    expect(response.status).toBe(200);
    return JSON.parse(response.body);
  };
  const challenge = (await request(BROWSER_RELAY_AUTH_CHALLENGE_PATH, {
    v: 2,
    keyId: relayKeyIdFromHex(token),
    clientNonce: randomRelayNonce(),
    role: "cdp",
    transport: "connection",
    method: flow === "cdp" ? "SEQUENCE" : "GET",
    resource: flow === "cdp" ? "/json/version -> /cdp" : "/json/list",
    flow,
  })) as BrowserRelayAuthChallenge;
  expect(verifyRelayProof(token, "server", challenge, challenge.serverProof)).toBe(true);
  const clientProof = createRelayProof(token, "client", challenge);
  const accepted = (await request(BROWSER_RELAY_AUTH_COMPLETE_PATH, {
    v: 2,
    sessionId: challenge.sessionId,
    clientProof,
  })) as { acceptProof: string };
  expect(verifyRelayProof(token, "accept", challenge, accepted.acceptProof, clientProof)).toBe(
    true,
  );
  return request;
}

/** An ordinary external v2 client: HTTP authentication/discovery/upgrade on one socket. */
export async function externalRelayClient(port: number, token: string): Promise<WebSocket> {
  const connection = await RawHttpConnection.connect(port);
  try {
    const request = await authenticateRelayHttp(connection, token, "cdp");
    await request("/json/version");
    const authenticated = connection.takeSocket();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      createConnection: () => authenticated,
    });
    await once(ws, "open");
    return ws;
  } catch (error) {
    connection.close();
    throw error;
  }
}

export async function externalVersion(ws: WebSocket): Promise<unknown> {
  return exchange(ws, { id: 1, method: "Browser.getVersion" });
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
      const runConnected = async () => {
        const start = async (mayReselectPort = false) => {
          const attempts = mayReselectPort ? 3 : 1;
          for (let attempt = 1; ; attempt += 1) {
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
        };
        const { port, daemon: initialDaemon } = await start(true);
        let daemon = initialDaemon;
        const extension = new WebSocket(
          `ws://127.0.0.1:${port}/extension`,
          BROWSER_RELAY_EXTENSION_SUBPROTOCOL,
          { origin: "chrome-extension://coexistence-test" },
        );
        const send = (message: Record<string, unknown>) => extension.send(JSON.stringify(message));
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
                  ? { targetInfo: { targetId: nativeTarget, title, type: "page", url } }
                  : command.method === "Page.getFrameTree"
                    ? { frameTree: { frame: { id: nativeTarget, ...FRAME } } }
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
                  detachReplies.splice(0).forEach((reply) => reply());
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
      };
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_OAUTH_DIR: credentials },
        runConnected,
      );
    });
  } finally {
    await releasePortClaim();
  }
}
