import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { WebSocket, WebSocketServer } from "openclaw/plugin-sdk/websocket-runtime";
import { describe, expect, it } from "vitest";
import { SHELLGATE_CADDY_SNIPPET } from "./caddy.js";
import {
  CREDENTIAL_STORE_OPTIONS,
  ShellgateCredentials,
  type ShellgateCredential,
} from "./credentials.js";
import { VERIFY_PATH, verifyShellgateRequest } from "./http.js";

const caddy = process.env.SHELLGATE_CADDY_BINARY?.trim();
const request = (url: string, init?: Parameters<typeof fetch>[1]) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(5000) });

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing proof listener");
  }
  return address.port;
}

/** Real external Caddy, synthetic upstream, and the production verifier/shared-state owner. */
describe.skipIf(!caddy)("Shellgate Caddy drop-in live", () => {
  it("adds Bearer beside unchanged Basic auth, preserving HTTP bodies and WebSocket identity", async () => {
    if (!caddy) {
      throw new Error("Set SHELLGATE_CADDY_BINARY to the Caddy executable");
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "shellgate-caddy-"));
    const credentials = new ShellgateCredentials(
      createPluginStateKeyedStoreV2ForTests<ShellgateCredential>(
        "shellgate",
        { ...CREDENTIAL_STORE_OPTIONS, env: { ...process.env, OPENCLAW_STATE_DIR: dir } },
        { assertCurrent: () => {} },
      ),
    );
    const subject = "local:service";
    const fields = (req: IncomingMessage) => ({
      user: req.headers["x-team-user"],
      authorizationPresent: Boolean(req.headers.authorization),
      scope: req.headers["x-openclaw-scopes"],
      factory: req.headers["x-factory-github-login"],
      method: req.method,
      url: req.url,
    });
    let verificationUpgrades = 0;
    let stalledRequestSeen = false;
    const upstream = createServer((req, res) => {
      if (req.url === "/stall") {
        stalledRequestSeen = true;
        return;
      }
      if (req.url === VERIFY_PATH) {
        void verifyShellgateRequest(req, res, credentials);
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () =>
        res.end(JSON.stringify({ ...fields(req), body: Buffer.concat(chunks).toString() })),
      );
    });
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    upstream.on("upgrade", (req, socket, head) => {
      if (req.url === VERIFY_PATH) {
        verificationUpgrades++;
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(req, socket, head, (ws) => ws.send(JSON.stringify(fields(req))));
    });
    let child: ChildProcess | undefined;
    let exit: Promise<unknown> | undefined;
    let client: WebSocket | undefined;
    try {
      const issued = await credentials.issue(subject);
      const upstreamPort = await listen(upstream);
      const reservation = createServer();
      const port = await listen(reservation);
      await new Promise<void>((resolve) => {
        reservation.close(() => resolve());
      });
      const hash = spawnSync(caddy, ["hash-password"], {
        input: "synthetic-basic-password\n",
        encoding: "utf8",
        timeout: 5000,
      });
      expect(hash.status).toBe(0);
      const file = path.join(dir, "Caddyfile");
      await writeFile(
        file,
        `{
      admin off
      auto_https off
    }
    ${SHELLGATE_CADDY_SNIPPET}
    http://127.0.0.1:${port} {
      route {
        import shellgate 127.0.0.1:${upstreamPort} X-Team-User
        basic_auth {
          human ${hash.stdout.trim()}
        }
        reverse_proxy 127.0.0.1:${upstreamPort} {
          header_up X-Team-User {http.auth.user.id}
          header_up -Authorization
        }
      }
    }`,
      );
      expect(
        spawnSync(caddy, ["validate", "--config", file], { stdio: "ignore", timeout: 5000 }).status,
      ).toBe(0);
      child = spawn(caddy, ["run", "--config", file], { stdio: "ignore" });
      exit = once(child, "exit").catch(() => undefined);
      const url = `http://127.0.0.1:${port}`;
      await expect
        .poll(async () => {
          try {
            return (await request(url)).status;
          } catch {
            return 0;
          }
        })
        .toBe(401);
      const basic = `Basic ${Buffer.from("human:synthetic-basic-password").toString("base64")}`;
      for (const [authorization, user] of [
        [basic, "human"],
        [`Bearer   ${issued.token}`, subject],
      ] as const) {
        const response = await request(url + "/echo?sample=1", {
          method: "POST",
          body: "synthetic body",
          headers: {
            authorization,
            "x-team-user": "local:admin",
            "x-openclaw-scopes": "operator.admin",
            "x-factory-github-login": "forged",
          },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          user,
          authorizationPresent: false,
          method: "POST",
          url: "/echo?sample=1",
          body: "synthetic body",
        });
      }
      client = new WebSocket(url.replace("http:", "ws:") + "/socket", {
        headers: { authorization: `Bearer ${issued.token}` },
      });
      const [data] = await once(client, "message", { signal: AbortSignal.timeout(5000) });
      expect(JSON.parse(String(data))).toEqual({
        user: subject,
        authorizationPresent: false,
        method: "GET",
        url: "/socket",
      });
      expect(verificationUpgrades).toBe(0);
      client.close();
      await once(client, "close", { signal: AbortSignal.timeout(5000) });
      expect((await request(url + VERIFY_PATH, { headers: { authorization: basic } })).status).toBe(
        404,
      );
      const invalid = await request(url, { headers: { authorization: "Bearer invalid" } });
      expect(invalid.status).toBe(401);
      expect(invalid.headers.get("www-authenticate")).toBe('Bearer realm="Shellgate"');
      await credentials.revoke(issued.id);
      expect(
        (await request(url, { headers: { authorization: `Bearer ${issued.token}` } })).status,
      ).toBe(401);
      expect((await request(url, { headers: { authorization: basic } })).status).toBe(200);
      await expect(
        request(url + "/stall", { headers: { authorization: basic } }),
      ).rejects.toThrow();
      expect(stalledRequestSeen).toBe(true);
    } finally {
      client?.terminate();
      for (const ws of sockets.clients) {
        ws.terminate();
      }
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      const killTimer = setTimeout(() => child?.kill("SIGKILL"), 1000);
      try {
        await exit;
      } finally {
        clearTimeout(killTimer);
      }
      sockets.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => {
        upstream.close(() => resolve());
      });
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
