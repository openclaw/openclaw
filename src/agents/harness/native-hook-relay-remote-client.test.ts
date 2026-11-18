import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createPlainServer } from "node:http";
import { createServer } from "node:https";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import tls from "node:tls";
import { expect, it, vi } from "vitest";
import * as httpFixtures from "../../../test/helpers/gateway-integration-fixtures.js";
import {
  PROXY_FIXTURE_CERTIFICATE as cert,
  PROXY_FIXTURE_KEY as key,
} from "../../test-helpers/proxy-tls-fixture.js";
import { invokeRemoteNativeHookRelay as invokeRelay } from "./native-hook-relay-remote-client.js";

it.skipIf(process.platform === "win32")(
  "denies a writerless FIFO credential through the relay CLI",
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "native-hook-fifo-"));
    const credential = path.join(dir, "credential.json");
    try {
      expect(spawnSync("mkfifo", [credential], { timeout: 5_000 }).status).toBe(0);
      // Bound the real process: a blocked open would otherwise strand a libuv worker.
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "./scripts/tsx.mjs",
          "src/cli/native-hook-relay-entry.ts",
          "hooks",
          "relay",
          "--provider",
          "codex",
          "--relay-id",
          "fifo-probe",
          "--event",
          "pre_tool_use",
          "--remote-credential",
          credential,
          // The relay deadline includes this cold TypeScript process start.
          "--timeout",
          "8000",
        ],
        { input: "{}", encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "Native hook relay unavailable",
        },
      });
      expect(result.stderr).toContain("Invalid native hook callback credential");
      expect((await lstat(credential)).isFIFO()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("verifies TLS and sends only the relay capability; refuses redirects and bounds responses", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-hook-https-"));
  const originalCAs = tls.getCACertificates("default");
  let received = 0;
  const requests: Promise<void>[] = [];
  let mode = "ok";
  const server = createServer({ key, cert }, (req, res) => {
    const request = (async () => {
      received++;
      expect(req).toMatchObject({
        headers: { authorization: "Bearer synthetic-relay-capability" },
        url: "/__openclaw__/native-hook/relay",
      });
      expect(JSON.parse((await buffer(req)).toString())).toMatchObject({
        generation: "current",
        relayId: "relay",
      });
      if (mode === "hang") {
        return;
      }
      res.writeHead(mode === "redirect" ? 302 : 200, {
        location: "https://127.0.0.1/never-follow",
      });
      res.end(
        mode === "large"
          ? "x".repeat(1024 * 1024 + 1)
          : JSON.stringify({ ok: true, result: { stdout: "allow", stderr: "", exitCode: 0 } }),
      );
    })();
    requests.push(request);
    void request.catch(() => res.destroy());
  });
  try {
    const url = `${await httpFixtures.listenLoopback(server, "https")}/__openclaw__/native-hook/relay`;
    const credential = path.join(dir, "credential.json");
    const save = (target: string) =>
      writeFile(credential, JSON.stringify({ url: target, token: "synthetic-relay-capability" }));
    const payload = {
      provider: "codex",
      relayId: "relay",
      generation: "current",
      event: "pre_tool_use",
      rawPayload: {},
    } as const;
    const invoke = (signal = AbortSignal.timeout(5_000)) =>
      invokeRelay(credential, payload, signal);
    await save(url);
    await expect(invoke()).rejects.toThrow("connection failed");
    expect(received).toBe(0);
    tls.setDefaultCACertificates([...originalCAs, cert]);
    await expect(invoke()).resolves.toMatchObject({ stdout: "allow", exitCode: 0 });
    mode = "redirect";
    await expect(invoke()).rejects.toThrow("rejected (302)");
    expect(received).toBe(2);
    mode = "large";
    await expect(invoke()).rejects.toThrow("response too large");
    mode = "hang";
    await expect(invoke(AbortSignal.timeout(30))).rejects.toThrow("connection failed");
    await save(url.replace("https:", "http:"));
    await expect(invoke()).rejects.toThrow("requires an HTTPS URL");
    await save(url + "?token=untrusted");
    await expect(invoke()).rejects.toThrow("requires an HTTPS URL");
    for (const invalid of [
      '{"token":"synthetic-relay-capability",invalid}',
      JSON.stringify({ url, token: "x".repeat(16_384) }),
    ]) {
      await writeFile(credential, invalid);
      await expect(invoke()).rejects.toThrow("Invalid native hook callback credential");
    }
    await Promise.all(requests);
  } finally {
    tls.setDefaultCACertificates(originalCAs);
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

it("tunnels through the explicit proxy only when Node's env-proxy switch is on", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-hook-proxy-"));
  const originalCAs = tls.getCACertificates("default");
  const tunnels: string[] = [];
  const seenByProxy: Buffer[] = [];
  let received = 0;
  const server = createServer({ key, cert }, (req, res) => {
    received++;
    void buffer(req).then(() =>
      res.end(JSON.stringify({ ok: true, result: { stdout: "allow", stderr: "", exitCode: 0 } })),
    );
  });
  // A minimal CONNECT proxy, like the only egress an explicit-proxy sandbox gives its workload.
  const proxy = createPlainServer((_req, res) => res.writeHead(405).end());
  proxy.on("connect", (req, socket, head) => {
    tunnels.push(req.url ?? "");
    seenByProxy.push(Buffer.from(JSON.stringify(req.headers)), head);
    socket.on("data", (chunk: Buffer) => seenByProxy.push(chunk));
    const [host, port] = (req.url ?? "").split(":");
    const upstream = connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  try {
    const url = `${await httpFixtures.listenLoopback(server, "https")}/__openclaw__/native-hook/relay`;
    const proxyUrl = await httpFixtures.listenLoopback(proxy, "http");
    const credential = path.join(dir, "credential.json");
    await writeFile(credential, JSON.stringify({ url, token: "synthetic-relay-capability" }));
    tls.setDefaultCACertificates([...originalCAs, cert]);
    const payload = {
      provider: "codex",
      relayId: "relay",
      generation: "current",
      event: "pre_tool_use",
      rawPayload: {},
    } as const;
    const invoke = () => invokeRelay(credential, payload, AbortSignal.timeout(5_000));
    for (const name of ["HTTPS_PROXY", "https_proxy"]) {
      vi.stubEnv(name, proxyUrl);
    }
    for (const name of ["NO_PROXY", "no_proxy"]) {
      vi.stubEnv(name, "");
    }
    vi.stubEnv("NODE_USE_ENV_PROXY", undefined);
    await expect(invoke()).resolves.toMatchObject({ stdout: "allow" });
    expect(tunnels).toEqual([]);
    vi.stubEnv("NODE_USE_ENV_PROXY", "1");
    await expect(invoke()).resolves.toMatchObject({ stdout: "allow" });
    expect(received).toBe(2);
    // The proxy sees only the target; the capability stays inside the TLS tunnel.
    expect(tunnels).toEqual([new URL(url).host]);
    const proxied = Buffer.concat(seenByProxy);
    expect(proxied.length).toBeGreaterThan(0);
    expect(proxied.includes("synthetic-relay-capability")).toBe(false);
  } finally {
    tls.setDefaultCACertificates(originalCAs);
    await httpFixtures.closeHttpServer(server);
    await httpFixtures.closeHttpServer(proxy);
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
