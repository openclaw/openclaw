import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { CreateSandboxBackendParams } from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSrtSandboxBackendFactory,
  shutdownSrtSandboxRuntime,
  SRT_SANDBOX_BACKEND_ID,
} from "./backend.js";
import { resolveSrtPluginConfig } from "./config.js";
import { isSrtSandboxAvailable } from "./sandbox-availability.test-helpers.js";

const isDarwin = process.platform === "darwin";
const isSupported = (isDarwin || process.platform === "linux") && (await isSrtSandboxAvailable());
const servers: Server[] = [];
const tempDirs: string[] = [];

function makeParams(workspaceDir: string, scopeKey: string): CreateSandboxBackendParams {
  return {
    sessionKey: scopeKey,
    scopeKey,
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    cfg: {
      mode: "all",
      backend: SRT_SANDBOX_BACKEND_ID,
      scope: "session",
      workspaceAccess: "rw",
      workspaceRoot: workspaceDir,
      dockerTmpfsSource: "default",
      docker: { workdir: workspaceDir, env: {} },
      ssh: {},
      browser: {},
      tools: {},
      prune: {},
    } as unknown as CreateSandboxBackendParams["cfg"],
  };
}

async function startLoopbackServer(): Promise<{ url: string; port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("srt-network-ok");
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("loopback test server did not bind a TCP port");
  }
  return { url: `http://127.0.0.1:${address.port}`, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(async () => {
  await shutdownSrtSandboxRuntime();
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!isSupported)("srt sandbox real backend network modes", () => {
  it("enforces deny-all, strict allowlist, and open through the initialized proxy/profile", async () => {
    const endpoint = await startLoopbackServer();

    const runMode = async (scopeKey: string, rawConfig: unknown) => {
      const workspaceDir = mkdtempSync(path.join(tmpdir(), `srt-network-${scopeKey}-`));
      tempDirs.push(workspaceDir);
      const factory = createSrtSandboxBackendFactory({
        pluginConfig: resolveSrtPluginConfig(rawConfig),
      });
      const handle = await factory(makeParams(workspaceDir, scopeKey));
      expect(SandboxManager.getProxyPort()).toBeTypeOf("number");
      const result = await handle.runShellCommand({
        script: `NO_PROXY= no_proxy= /usr/bin/curl --fail --silent --show-error --max-time 3 ${endpoint.url}`,
        allowFailure: true,
      });
      return { handle, result };
    };

    const denied = await runMode("deny", { network: "deny" });
    expect(denied.result.code).not.toBe(0);
    await shutdownSrtSandboxRuntime();

    const allowlisted = await runMode("allowlist", {
      network: "deny",
      allowedDomains: [`127.0.0.1:${endpoint.port}`],
    });
    expect(allowlisted.result.code).toBe(0);
    expect(allowlisted.result.stdout.toString("utf8")).toBe("srt-network-ok");
    const rejectedHost = await allowlisted.handle.runShellCommand({
      script: `NO_PROXY= no_proxy= /usr/bin/curl --fail --silent --show-error --max-time 3 http://localhost:${endpoint.port}`,
      allowFailure: true,
    });
    expect(rejectedHost.code).not.toBe(0);
    await shutdownSrtSandboxRuntime();

    const open = await runMode("open", { network: "allow" });
    expect(open.result.code).toBe(0);
    expect(open.result.stdout.toString("utf8")).toBe("srt-network-ok");

    const spec = await open.handle.buildExecSpec({
      command: "true",
      env: { PATH: process.env.PATH ?? "" },
      usePty: false,
    });
    const wrappedArgv = Buffer.from(spec.env.SRT_CUSTODY_ARGV!, "base64").toString("utf8");
    if (isDarwin) {
      expect(wrappedArgv).toContain("sandbox-exec");
      expect(wrappedArgv).toContain("allow network-outbound");
      expect(wrappedArgv).toContain(`localhost:${SandboxManager.getProxyPort()}`);
    } else {
      expect(wrappedArgv).toContain("bwrap");
    }
  });
});
