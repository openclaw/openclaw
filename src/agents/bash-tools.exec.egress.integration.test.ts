import fs from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { generateLocalProxyLeaf } from "../proxy-capture/ca.js";
import { startGatewaySecretEgressProxy } from "../secrets/egress-proxy/runtime.js";
import { writeSecretStoreEntry } from "../secrets/store/secret-store.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const value = "synthetic-egress-exec-credential";
const run = { instanceId: "egress-exec-instance", runId: "egress-exec-run" };

// Shell variable expansion is POSIX-specific; the proxy transport itself has portable coverage.
describe.skipIf(process.platform === "win32")("exec secret egress final spawn", () => {
  let root: string;
  let proxy: Awaited<ReturnType<typeof startGatewaySecretEgressProxy>> | undefined;
  let servers: Server[];
  let substituted: boolean[];
  let decoyHits: number;
  let target: string;
  let decoyUrl: string;

  async function listen(server: Server): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("fixture did not bind a TCP port");
    }
    return address.port;
  }

  beforeEach(async () => {
    root = tempDirs.make("exec-egress-spawn-");
    servers = [];
    substituted = [];
    decoyHits = 0;
    for (const key of ["HOME", "USERPROFILE", "OPENCLAW_HOME", "ZDOTDIR"]) {
      vi.stubEnv(key, root);
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "absent.json"));
    vi.stubEnv("SHELL", "/bin/bash");
    for (const key of ["NO_PROXY", "no_proxy"]) {
      vi.stubEnv(key, "");
    }
    proxy = await startGatewaySecretEgressProxy({ allowedHosts: ["127.0.0.1"] });
    const certDir = path.dirname(proxy.caCertPath);
    const leaf = await generateLocalProxyLeaf({
      certDir,
      ca: { certPath: proxy.caCertPath, keyPath: path.join(certDir, "root-ca-key.pem") },
      hostname: "127.0.0.1",
    });
    const port = await listen(
      createHttpsServer(leaf, (request, response) => {
        const matched = request.headers["x-fixture"] === value;
        substituted.push(matched);
        response.writeHead(matched ? 200 : 401);
        response.end();
      }),
    );
    target = `https://127.0.0.1:${port}/fixture`;
    const decoy = createServer((_request, response) => {
      decoyHits++;
      response.writeHead(418);
      response.end();
    });
    decoy.on("connect", (_request, socket) => {
      decoyHits++;
      socket.end("HTTP/1.1 418 Decoy\r\nConnection: close\r\n\r\n");
    });
    decoyUrl = `http://127.0.0.1:${await listen(decoy)}`;
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
    ]) {
      vi.stubEnv(key, decoyUrl);
    }
    writeSecretStoreEntry({
      name: "EGRESS_EXEC_TOKEN",
      value,
      kind: "secret",
      scope: { kind: "team" },
      updatedBy: "test",
      allowedHosts: ["127.0.0.1"],
    });
  });

  afterAll(async () => {
    await drainGlobalSingletonLifecycleState();
  });

  afterEach(async () => {
    resetProcessRegistryForTests();
    await proxy?.stop();
    proxy = undefined;
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  function tool(security?: "deny") {
    return createExecTool({
      host: "gateway",
      cwd: root,
      operationalRunInstance: run,
      security,
      allowBackground: false,
      notifyOnExit: false,
      timeoutSec: 10,
    });
  }

  async function execute(command: string) {
    const result = await tool().execute("egress-fixture", { command, yieldMs: 10_000 });
    expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
    return result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  }

  function curl() {
    return `curl --silent --show-error --max-time 5 --output /dev/null --write-out '%{http_code}\\n' --header "x-fixture: $EGRESS_EXEC_TOKEN" '${target}'`;
  }

  it.each(["conflicting lowercase", "empty lowercase"])(
    "routes %s through the real spawn and substitutes only at the proxy",
    async (mode) => {
      if (mode === "empty lowercase") {
        vi.stubEnv("https_proxy", "");
        vi.stubEnv("http_proxy", "");
      }
      expect(await execute(curl())).toMatch(/(?:^|\n)200(?:\n|$)/u);
      expect(substituted).toEqual([true]);
      expect(decoyHits).toBe(0);
    },
  );

  it.each(["no_proxy", "NO_PROXY"])(
    "preserves %s bypass without substituting the sentinel",
    async (key) => {
      vi.stubEnv(key, "127.0.0.1");
      expect(await execute(curl())).toMatch(/(?:^|\n)401(?:\n|$)/u);
      expect(substituted).toEqual([false]);
      expect(decoyHits).toBe(0);
    },
  );

  it("preserves unrelated proxy variables and keeps the child secret opaque", async () => {
    vi.stubEnv("no_proxy", "fixture.invalid");
    const script = path.join(root, "environment.cjs");
    fs.writeFileSync(
      script,
      `const e = process.env; console.log(JSON.stringify({aliases: e.http_proxy === e.HTTP_PROXY && e.https_proxy === e.HTTPS_PROXY, all: e.ALL_PROXY === ${JSON.stringify(decoyUrl)} && e.all_proxy === ${JSON.stringify(decoyUrl)}, bypass: e.no_proxy === 'fixture.invalid', opaque: e.EGRESS_EXEC_TOKEN.startsWith('oc-sent-v2.')}));`,
    );
    const output = await execute(`'${process.execPath}' '${script}'`);
    expect(JSON.parse(output.slice(output.indexOf("{")))).toEqual({
      aliases: true,
      all: true,
      bypass: true,
      opaque: true,
    });
  });

  it("preserves inherited lowercase routing and omits secrets when disabled", async () => {
    await proxy!.stop();
    const script = path.join(root, "disabled.cjs");
    fs.writeFileSync(
      script,
      `console.log(JSON.stringify({absent: !process.env.EGRESS_EXEC_TOKEN, lower: process.env.http_proxy === ${JSON.stringify(decoyUrl)}}));`,
    );
    const output = await execute(`'${process.execPath}' '${script}'`);
    expect(JSON.parse(output.slice(output.indexOf("{")))).toEqual({ absent: true, lower: true });
  });

  it.each([0, 7])("revokes the final child's process grant on exit %s", async (exitCode) => {
    const grantPath = path.join(root, "child-grant");
    const script = path.join(root, "capture-grant.cjs");
    fs.writeFileSync(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(grantPath)}, process.env.https_proxy, {mode: 0o600}); process.exit(${exitCode});`,
    );
    const result = await tool().execute("capture-grant", {
      command: `'${process.execPath}' '${script}'`,
      yieldMs: 10_000,
    });
    expect(result.details).toMatchObject({ status: "completed", exitCode });
    const url = new URL(fs.readFileSync(grantPath, "utf8"));
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: target,
          agent: false,
          headers: {
            "Proxy-Authorization": `Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}`,
          },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
        },
      );
      request.once("error", reject);
      request.end();
    });
    expect(status).toBe(407);
    expect(substituted).toEqual([]);
    expect(decoyHits).toBe(0);
  });

  it("removes its CA and exit cleanup listener on stop", async () => {
    const caDir = path.dirname(proxy!.caCertPath);
    const exitListeners = process.listenerCount("exit");
    await proxy!.stop();
    expect(fs.existsSync(caDir)).toBe(false);
    expect(process.listenerCount("exit")).toBe(exitListeners - 1);
  });

  it("enforces exec denial before any request", async () => {
    await expect(tool("deny").execute("denied", { command: curl() })).rejects.toThrow(
      "security=deny",
    );
    expect(substituted).toEqual([]);
    expect(decoyHits).toBe(0);
  });
});
