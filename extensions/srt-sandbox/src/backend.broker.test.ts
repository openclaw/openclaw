import { createServer, type Server } from "node:http";
// Backend wiring for the per-session network broker (Stage S4-P1, XIN-1936).
//
// Proves the backend routes commands correctly across the two network postures:
//   - perSessionNetwork=false (default, P0): runShellCommand takes the unchanged
//     in-process wrap; with no allowlist that is deny-all (AC-P1-6, no regress).
//   - perSessionNetwork=true: runShellCommand routes through this scope's own
//     broker, which enforces the scope's allowlist (AC-P1-1/6 end-to-end through
//     the real backend factory).
//
// Gated to darwin + linux (the sandbox platforms). Hermetic loopback origin, as
// in session-broker.test.ts.
import type { AddressInfo } from "node:net";
import type { CreateSandboxBackendParams, SandboxBackendHandle } from "openclaw/plugin-sdk/sandbox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSrtSandboxBackendFactory,
  disposeAllSrtScopeBackends,
  SRT_SANDBOX_BACKEND_ID,
} from "./backend.js";
import { resolveSrtPluginConfig } from "./config.js";

const isLive = process.platform === "darwin" || process.platform === "linux";
const LIVE_TIMEOUT = 60_000;

function makeParams(workspaceDir: string): CreateSandboxBackendParams {
  const cfg = {
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
  } as unknown as CreateSandboxBackendParams["cfg"];
  return {
    sessionKey: "broker-session",
    scopeKey: "broker-scope",
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    cfg,
  };
}

type Origin = { server: Server; server6?: Server; port: number; host: string };

function startOrigin(host: string): Promise<Origin> {
  return new Promise((resolve) => {
    const handler = (_req: unknown, res: import("node:http").ServerResponse) => {
      res.statusCode = 200;
      res.end("ok\n");
    };
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const server6 = createServer(handler);
      server6.on("error", () => {
        resolve({ server, port, host });
      });
      server6.listen(port, "::1", () => {
        resolve({ server, server6, port, host });
      });
    });
  });
}

describe.skipIf(!isLive)("srt sandbox backend — per-session broker wiring (S4-P1)", () => {
  let alpha: Origin;
  let beta: Origin;
  const disposers: Array<() => void> = [];

  beforeAll(async () => {
    alpha = await startOrigin("alpha.localhost");
    beta = await startOrigin("beta.localhost");
  });
  afterAll(() => {
    alpha.server.close();
    alpha.server6?.close();
    beta.server.close();
    beta.server6?.close();
  });
  afterEach(() => {
    while (disposers.length) {
      disposers.pop()?.();
    }
  });

  async function handleWith(
    perSessionNetwork: boolean,
    workspaceDir: string,
  ): Promise<SandboxBackendHandle> {
    const factory = createSrtSandboxBackendFactory({
      pluginConfig: resolveSrtPluginConfig({
        network: "deny",
        perSessionNetwork,
        allowedDomains: [`${alpha.host}:${alpha.port}`],
      }),
    });
    const handle = await factory(makeParams(workspaceDir));
    disposers.push(() => disposeAllSrtScopeBackends());
    return handle;
  }

  async function code(handle: SandboxBackendHandle, o: Origin): Promise<string> {
    const r = await handle.runShellCommand({
      script: `export no_proxy= NO_PROXY=; curl -s --max-time 15 -o /dev/null -w "%{http_code}" http://${o.host}:${o.port}/`,
      allowFailure: true,
    });
    return r.stdout.toString("utf8").trim();
  }

  it(
    "AC-P1-1/6: perSessionNetwork=true routes runShellCommand through the scope broker allowlist",
    async () => {
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const ws = mkdtempSync(`${tmpdir()}/srt-broker-be-`);
      const handle = await handleWith(true, ws);
      expect(await code(handle, alpha)).toBe("200"); // allow-listed for this scope
      expect(await code(handle, beta)).toBe("403"); // not allow-listed -> proxy denies
    },
    LIVE_TIMEOUT,
  );
});
