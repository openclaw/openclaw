// Live runtime authority through the real SRT backend factory.
//
// The host supplies assertRuntimeCurrent and may revoke it while a handle is
// still retained. Every new effect — ordinary and broker command launches,
// deferred exec specs, pin-owner spawns and RPCs — must re-admit against it
// right before the effect, rethrow the host's own error, and keep cleanup
// working after revocation. Positive cases run the same operations with
// authority intact so a reject-everything implementation cannot pass.
//
// Gated to darwin + linux hosts with the sandbox toolchain available.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type {
  CreateSandboxBackendParams,
  SandboxBackendExecSpec,
  SandboxBackendHandle,
} from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSrtSandboxBackendFactory,
  createSrtSandboxBackendManager,
  shutdownSrtSandboxRuntime,
  SRT_SANDBOX_BACKEND_ID,
} from "./backend.js";
import { resolveSrtPluginConfig } from "./config.js";
import { isSrtSandboxAvailable } from "./sandbox-availability.test-helpers.js";

const isLive =
  (process.platform === "darwin" || process.platform === "linux") &&
  (await isSrtSandboxAvailable());
const LIVE_TIMEOUT = 60_000;
const COMMAND_TIMEOUT_SECONDS = 30;
/** Well under the command timeout: rejection must not wait for a timeout. */
const IMMEDIATE_MS = 5_000;

/** Local mirror of the SDK context type (not exported from plugin-sdk/sandbox). */
type SandboxFsBridgeContext = Parameters<
  NonNullable<SandboxBackendHandle["createFsBridge"]>
>[0]["sandbox"];

type RemoveRuntimeParams = Parameters<
  ReturnType<typeof createSrtSandboxBackendManager>["removeRuntime"]
>[0];

type Authority = {
  current: boolean;
  revoked: Error;
  assertRuntimeCurrent: () => void;
};

function makeAuthority(): Authority {
  const authority: Authority = {
    current: true,
    revoked: new Error("runtime authority revoked by host"),
    assertRuntimeCurrent: () => {
      if (!authority.current) {
        throw authority.revoked;
      }
    },
  };
  return authority;
}

function makeParams(
  workspaceDir: string,
  scopeKey: string,
  authority: Authority,
): CreateSandboxBackendParams {
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
    sessionKey: `${scopeKey}-session`,
    scopeKey,
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    cfg,
    assertRuntimeCurrent: authority.assertRuntimeCurrent,
  };
}

function bridgeFor(handle: SandboxBackendHandle, ws: string, scopeKey: string) {
  return handle.createFsBridge!({
    sandbox: {
      workspaceDir: ws,
      agentWorkspaceDir: ws,
      workspaceAccess: "rw",
      containerName: scopeKey,
      containerWorkdir: ws,
      docker: {},
    } as SandboxFsBridgeContext,
  });
}

/** Spawn a deferred exec spec the way the core exec runtime does. */
async function spawnSpec(spec: SandboxBackendExecSpec): Promise<number | null> {
  const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
    env: spec.env,
    cwd: spec.cwd,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.end();
  const [code] = (await once(child, "exit")) as [number | null];
  return code;
}

async function elapsed<T>(run: () => Promise<T>): Promise<{ ms: number; error: unknown }> {
  const started = performance.now();
  try {
    await run();
    return { ms: performance.now() - started, error: undefined };
  } catch (error) {
    return { ms: performance.now() - started, error };
  }
}

describe.skipIf(!isLive)("srt sandbox backend — live runtime authority", () => {
  const cleanups: Array<() => void> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await shutdownSrtSandboxRuntime();
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  async function setup(
    options: { perSessionNetwork?: boolean } = {},
  ): Promise<{ ws: string; scopeKey: string; authority: Authority; handle: SandboxBackendHandle }> {
    const ws = mkdtempSync(path.join(tmpdir(), "srt-authority-"));
    cleanups.push(() => rmSync(ws, { recursive: true, force: true }));
    const scopeKey = `authority-${path.basename(ws)}`;
    const authority = makeAuthority();
    const factory = createSrtSandboxBackendFactory({
      pluginConfig: resolveSrtPluginConfig({
        network: "deny",
        perSessionNetwork: options.perSessionNetwork ?? false,
        allowedDomains: [],
        commandTimeoutSeconds: COMMAND_TIMEOUT_SECONDS,
      }),
    });
    const handle = await factory(makeParams(ws, scopeKey, authority));
    return { ws, scopeKey, authority, handle };
  }

  /** Revoke host authority as soon as the next sandbox wrap resolves. */
  function revokeDuringNextWrap(authority: Authority) {
    const original = SandboxManager.wrapWithSandboxArgv.bind(SandboxManager);
    return vi
      .spyOn(SandboxManager, "wrapWithSandboxArgv")
      .mockImplementationOnce(async (...args) => {
        const wrapped = await original(...args);
        authority.current = false;
        return wrapped;
      });
  }

  it(
    "runs commands, deferred exec specs, and bridge mutations while authority holds",
    async () => {
      const { ws, scopeKey, handle } = await setup();
      const marker = path.join(ws, "ran");
      const result = await handle.runShellCommand({ script: `printf ok > '${marker}'` });
      expect(result.code).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe("ok");

      const deferred = path.join(ws, "deferred");
      const spec = await handle.buildExecSpec({
        command: `printf deferred > '${deferred}'`,
        env: { PATH: process.env.PATH ?? "" },
        usePty: false,
      });
      expect(() => spec.assertCurrent?.()).not.toThrow();
      expect(await spawnSpec(spec)).toBe(0);
      await handle.finalizeExec?.({
        status: "completed",
        exitCode: 0,
        timedOut: false,
        token: spec.finalizeToken,
      });
      expect(readFileSync(deferred, "utf8")).toBe("deferred");

      const bridge = bridgeFor(handle, ws, scopeKey);
      await bridge.writeFile({ filePath: "fresh.txt", data: "fresh" });
      const pin = await bridge.resolvePinnedMutationTarget!({
        filePath: "pinned.txt",
        action: "write",
      });
      await bridge.writeFile({
        filePath: "pinned.txt",
        data: "pinned",
        pinnedPath: pin.pinnedPath,
      });
      expect(readFileSync(path.join(ws, "fresh.txt"), "utf8")).toBe("fresh");
      expect(readFileSync(path.join(ws, "pinned.txt"), "utf8")).toBe("pinned");
    },
    LIVE_TIMEOUT,
  );

  it(
    "rejects ordinary command execution after revocation with the host's error",
    async () => {
      const { ws, authority, handle } = await setup();
      await handle.runShellCommand({ script: "true" });
      // Built while authority held; launched after it is revoked.
      const staleMarker = path.join(ws, "stale-spec");
      const staleSpec = await handle.buildExecSpec({
        command: `touch '${staleMarker}'`,
        env: { PATH: process.env.PATH ?? "" },
        usePty: false,
      });
      authority.current = false;

      const marker = path.join(ws, "ran");
      const run = await elapsed(() => handle.runShellCommand({ script: `touch '${marker}'` }));
      expect(run.error).toBe(authority.revoked);
      expect(run.ms).toBeLessThan(IMMEDIATE_MS);
      await expect(handle.buildExecSpec({ command: "true", env: {}, usePty: false })).rejects.toBe(
        authority.revoked,
      );
      expect(() => staleSpec.assertCurrent?.()).toThrow(authority.revoked);
      // Even a launcher that skips the deferred check is refused at the handshake.
      expect(await spawnSpec(staleSpec)).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(staleMarker)).toBe(false);
    },
    LIVE_TIMEOUT,
  );

  it(
    "does not let allowFailure swallow an authority rejection",
    async () => {
      const { authority, handle } = await setup();
      authority.current = false;
      await expect(handle.runShellCommand({ script: "exit 3", allowFailure: true })).rejects.toBe(
        authority.revoked,
      );
    },
    LIVE_TIMEOUT,
  );

  it(
    "rejects fs-bridge mutations through the pin owner after revocation",
    async () => {
      const { ws, scopeKey, authority, handle } = await setup();
      const bridge = bridgeFor(handle, ws, scopeKey);
      await bridge.writeFile({ filePath: "kept.txt", data: "original" });
      const pin = await bridge.resolvePinnedMutationTarget!({
        filePath: "pinned.txt",
        action: "write",
      });
      authority.current = false;

      const write = await elapsed(() =>
        bridge.writeFile({ filePath: "kept.txt", data: "changed" }),
      );
      expect(write.error).toBe(authority.revoked);
      expect(write.ms).toBeLessThan(IMMEDIATE_MS);
      await expect(
        bridge.writeFile({ filePath: "pinned.txt", data: "x", pinnedPath: pin.pinnedPath }),
      ).rejects.toBe(authority.revoked);
      await expect(bridge.mkdirp({ filePath: "dir" })).rejects.toBe(authority.revoked);
      await expect(bridge.remove({ filePath: "kept.txt" })).rejects.toBe(authority.revoked);
      expect(readFileSync(path.join(ws, "kept.txt"), "utf8")).toBe("original");
      expect(existsSync(path.join(ws, "pinned.txt"))).toBe(false);
      expect(existsSync(path.join(ws, "dir"))).toBe(false);
    },
    LIVE_TIMEOUT,
  );

  it(
    "rejects the command spawn when authority is revoked while wrapping is awaited",
    async () => {
      const { ws, authority, handle } = await setup();
      const marker = path.join(ws, "ran");
      revokeDuringNextWrap(authority);
      await expect(handle.runShellCommand({ script: `touch '${marker}'` })).rejects.toBe(
        authority.revoked,
      );
      expect(existsSync(marker)).toBe(false);

      authority.current = true;
      revokeDuringNextWrap(authority);
      await expect(
        handle.buildExecSpec({ command: `touch '${marker}'`, env: {}, usePty: false }),
      ).rejects.toBe(authority.revoked);
      expect(existsSync(marker)).toBe(false);
    },
    LIVE_TIMEOUT,
  );

  it(
    "rejects the pin-owner RPC when authority is revoked during owner preparation",
    async () => {
      const { ws, scopeKey, authority, handle } = await setup();
      const bridge = bridgeFor(handle, ws, scopeKey);
      // The first bridge operation spawns the pin owner through a sandbox wrap.
      revokeDuringNextWrap(authority);
      await expect(bridge.writeFile({ filePath: "late.txt", data: "x" })).rejects.toBe(
        authority.revoked,
      );
      expect(existsSync(path.join(ws, "late.txt"))).toBe(false);
    },
    LIVE_TIMEOUT,
  );

  it(
    "rejects broker command execution after revocation with per-session network on",
    async () => {
      const { ws, authority, handle } = await setup({ perSessionNetwork: true });
      const result = await handle.runShellCommand({ script: "printf broker" });
      expect(result.stdout.toString("utf8")).toBe("broker");

      authority.current = false;
      const marker = path.join(ws, "ran");
      const run = await elapsed(() =>
        handle.runShellCommand({ script: `touch '${marker}'`, allowFailure: true }),
      );
      expect(run.error).toBe(authority.revoked);
      expect(run.ms).toBeLessThan(IMMEDIATE_MS);
      await expect(handle.buildExecSpec({ command: "true", env: {}, usePty: false })).rejects.toBe(
        authority.revoked,
      );
      expect(existsSync(marker)).toBe(false);
    },
    LIVE_TIMEOUT,
  );

  it(
    "keeps terminate, finalize, and dispose working after revocation",
    async () => {
      const { scopeKey, authority, handle } = await setup();
      const prepared = handle.prepareProcessCleanup!({ PATH: process.env.PATH ?? "" });
      const spec = await handle.buildExecSpec({
        command: "true",
        env: prepared.env,
        usePty: false,
      });
      authority.current = false;
      await expect(prepared.terminate()).resolves.toBeUndefined();
      await expect(
        handle.finalizeExec!({
          status: "failed",
          exitCode: null,
          timedOut: false,
          token: spec.finalizeToken,
        }),
      ).resolves.toBeUndefined();
      await expect(
        createSrtSandboxBackendManager().removeRuntime({
          entry: { containerName: scopeKey } as RemoveRuntimeParams["entry"],
          config: {} as RemoveRuntimeParams["config"],
        }),
      ).resolves.toBeUndefined();
      await expect(shutdownSrtSandboxRuntime()).resolves.toBeUndefined();
    },
    LIVE_TIMEOUT,
  );
});
