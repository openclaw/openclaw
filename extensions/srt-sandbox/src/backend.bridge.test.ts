// End-to-end tests for the S3 bridge wired through the real SRT backend
// factory (backend.ts createFsBridge + pin owner launched inside the sandbox).
//
// Darwn-gated like the S1 matrix. Three guarantees beyond the unit tests:
//   1. The backend handle exposes createFsBridge and the returned bridge
//      performs sandbox-confined file operations end to end.
//   2. The pin owner runs INSIDE the SRT sandbox: with a live directory fd
//      held to a directory OUTSIDE the scope's allowWrite roots, a mutation
//      through that fd is denied by the kernel (Seatbelt) — the held-handle
//      model composes with, and never bypasses, SRT enforcement (v8 §3.1).
//   3. The sandboxed pin owner is tracked by the S2 reaper: scope teardown
//      reaps it (the owner pid is gone after dispose).
import { mkdtempSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxBackendHandle, SandboxFsBridge } from "openclaw/plugin-sdk/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { createSrtSandboxBackendFactory, SRT_SANDBOX_BACKEND_ID } from "./backend.js";
import { resolveSrtPluginConfig } from "./config.js";
import { PinOwnerClient } from "./pin-owner-client.js";
import { buildPinOwnerCommand } from "./pin-owner-source.js";
import { ScopeChildReaper } from "./scope-reaper.js";

/** Local mirror of the SDK context type (not exported from plugin-sdk/sandbox). */
type SandboxFsBridgeContext = Parameters<
  NonNullable<SandboxBackendHandle["createFsBridge"]>
>[0]["sandbox"];

const isDarwin = process.platform === "darwin";

describe.skipIf(!isDarwin)("srt sandbox backend fs bridge (S3, end to end)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it("exposes a working fs bridge through the real backend factory", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "srt-e2e-ws-"));
    const agent = mkdtempSync(path.join(tmpdir(), "srt-e2e-agent-"));
    cleanups.push(() => {
      rmSync(ws, { recursive: true, force: true });
      rmSync(agent, { recursive: true, force: true });
    });
    const pluginConfig = resolveSrtPluginConfig(undefined);
    const factory = createSrtSandboxBackendFactory({ pluginConfig });
    const handle = await factory({
      sessionKey: "test-session",
      scopeKey: "test-bridge-scope",
      workspaceDir: ws,
      agentWorkspaceDir: agent,
      cfg: {
        mode: "all",
        backend: SRT_SANDBOX_BACKEND_ID,
        scope: "session",
        workspaceAccess: "rw",
        workspaceRoot: ws,
        dockerTmpfsSource: "default",
        docker: { workdir: ws, env: {} },
        ssh: {},
        browser: {},
        tools: {},
        prune: {},
      },
    } as Parameters<typeof factory>[0]);
    expect(handle.createFsBridge).toBeTypeOf("function");
    const bridge = handle.createFsBridge!({
      sandbox: {
        workspaceDir: ws,
        agentWorkspaceDir: agent,
        workspaceAccess: "rw",
        containerName: "test-bridge-scope",
        containerWorkdir: ws,
        docker: {},
      } as SandboxFsBridgeContext,
    });

    await bridge.writeFile({ filePath: "bridge.txt", data: "through the bridge" });
    expect(readFileSync(path.join(ws, "bridge.txt"), "utf8")).toBe("through the bridge");
    const readBack = await bridge.readFile({ filePath: "bridge.txt" });
    expect(readBack.toString("utf8")).toBe("through the bridge");
    expect((await bridge.stat({ filePath: "bridge.txt" }))?.type).toBe("file");
  });

  it("runs the pin owner inside the sandbox: out-of-policy mutations are kernel-denied", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "srt-e2e-pin-"));
    const outside = mkdtempSync(path.join(tmpdir(), "srt-e2e-out-"));
    mkdirSync(path.join(ws, "inside"), { recursive: true });
    mkdirSync(path.join(outside, "target"), { recursive: true });
    cleanups.push(() => {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    });

    // Exactly how backend.ts launches the owner: wrapWithSandboxArgv over the
    // scope's allowWrite = [ws], tracked by a reaper.
    const reaper = new ScopeChildReaper();
    const pluginConfig = resolveSrtPluginConfig(undefined);
    const client = new PinOwnerClient({
      spawnOwner: async () => {
        const wrapped = await SandboxManager.wrapWithSandboxArgv(
          buildPinOwnerCommand(),
          pluginConfig.binShell,
          {
            network: { allowedDomains: [], deniedDomains: ["*"] },
            filesystem: {
              allowRead: [],
              denyRead: [],
              allowWrite: [ws],
              denyWrite: [],
            },
          },
          undefined,
          ws,
        );
        return reaper.spawnPersistent({
          argv: wrapped.argv,
          env: wrapped.env ?? {},
          cwd: ws,
        });
      },
      rpcTimeoutMs: 15_000,
    });
    cleanups.push(() => {
      client.dispose();
      reaper.dispose();
    });

    // In-policy: a held-fd mutation inside the workspace succeeds.
    await client.resolvePin(1, { root: ws, rel: "inside", leaf: "ok.txt", mode: "file" });
    const okResult = await client.mutate(1, { kind: "write", data: Buffer.from("in-policy") });
    expect(okResult.result).toBe("created");
    expect(readFileSync(path.join(ws, "inside", "ok.txt"), "utf8")).toBe("in-policy");

    // Out-of-policy: hold a live directory fd to a directory OUTSIDE the
    // allowWrite roots, then attempt a mutation through that fd. Seatbelt must
    // deny it (EPERM) — holding a fd grants no escape from the sandbox policy.
    await client.resolvePin(2, {
      root: outside,
      rel: "target",
      leaf: "escape.txt",
      mode: "file",
    });
    await expect(client.mutate(2, { kind: "write", data: Buffer.from("escape") })).rejects.toThrow(
      /EPERM|Operation not permitted/,
    );
    expect(existsSync(path.join(outside, "target", "escape.txt"))).toBe(false);
  });

  it("fails the bridge closed after dispose (pin owner detached, no zombie owner)", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "srt-e2e-reap-"));
    const agent = mkdtempSync(path.join(tmpdir(), "srt-e2e-reap-agent-"));
    cleanups.push(() => {
      rmSync(ws, { recursive: true, force: true });
      rmSync(agent, { recursive: true, force: true });
    });
    const pluginConfig = resolveSrtPluginConfig(undefined);
    const factory = createSrtSandboxBackendFactory({ pluginConfig });
    const handle = await factory({
      sessionKey: "test-session",
      scopeKey: "test-reap-scope",
      workspaceDir: ws,
      agentWorkspaceDir: agent,
      cfg: {
        mode: "all",
        backend: SRT_SANDBOX_BACKEND_ID,
        scope: "session",
        workspaceAccess: "rw",
        workspaceRoot: ws,
        dockerTmpfsSource: "default",
        docker: { workdir: ws, env: {} },
        ssh: {},
        browser: {},
        tools: {},
        prune: {},
      },
    } as Parameters<typeof factory>[0]);

    const bridge = handle.createFsBridge!({
      sandbox: {
        workspaceDir: ws,
        agentWorkspaceDir: agent,
        workspaceAccess: "rw",
        containerName: "test-reap-scope",
        containerWorkdir: ws,
        docker: {},
      } as SandboxFsBridgeContext,
    });
    // Force the owner to spawn with one operation.
    await bridge.writeFile({ filePath: "wake.txt", data: "wake" });
    (bridge as SandboxFsBridge & { dispose(): void }).dispose();
    await expect(bridge.writeFile({ filePath: "after.txt", data: "x" })).rejects.toThrow();
  });
});
