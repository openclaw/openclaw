// End-to-end reaper tests for the SRT sandbox backend (Stage S2), darwin-only.
//
// Proves the worker-per-scope reaper (design v8 §S2) composes with the real
// macOS Seatbelt wrap: a runShellCommand that starts a background descendant
// leaves no survivor, and tearing the scope down via the backend manager reaps
// an in-flight command's whole process group. Complements backend.test.ts
// (the S1 registration + Seatbelt 8/8 matrix), which is left untouched.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CreateSandboxBackendParams,
  SandboxBackendManager,
} from "openclaw/plugin-sdk/sandbox";
import { describe, expect, it } from "vitest";
import {
  createSrtSandboxBackendFactory,
  createSrtSandboxBackendManager,
  SRT_SANDBOX_BACKEND_ID,
} from "./backend.js";
import { resolveSrtPluginConfig } from "./config.js";

type RemoveRuntimeParams = Parameters<SandboxBackendManager["removeRuntime"]>[0];

const isDarwin = process.platform === "darwin";

const sleepMs = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectDeadWithin(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return;
    }
    await sleepMs(50);
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

function makeParams(scopeKey: string, workspaceDir: string): CreateSandboxBackendParams {
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
    sessionKey: scopeKey,
    scopeKey,
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
    cfg,
  };
}

describe.skipIf(!isDarwin)("srt sandbox backend reaper (S2)", () => {
  it("reaps a background descendant started inside a sandboxed command", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "srt-e2e-ws-"));
    const descFile = path.join(ws, "desc.pid");
    const factory = createSrtSandboxBackendFactory({
      pluginConfig: resolveSrtPluginConfig(undefined),
    });
    const handle = await factory(makeParams("scope-e2e-desc", ws));

    // The writable zone is the workspace; write the descendant pid there.
    await handle.runShellCommand({
      script: `sleep 120 & echo $! > ${descFile}; exit 0`,
      allowFailure: true,
    });
    const descPid = Number(readFileSync(descFile, "utf8").trim());
    expect(Number.isInteger(descPid)).toBe(true);
    await expectDeadWithin(descPid);
  });

  it("tears down an in-flight command's process group on manager.removeRuntime", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "srt-e2e-teardown-"));
    const descFile = path.join(ws, "desc.pid");
    const scopeKey = "scope-e2e-teardown";
    const factory = createSrtSandboxBackendFactory({
      pluginConfig: resolveSrtPluginConfig(undefined),
    });
    const manager = createSrtSandboxBackendManager();
    const handle = await factory(makeParams(scopeKey, ws));

    const pending = handle.runShellCommand({
      script: `sleep 120 & echo $! > ${descFile}; wait`,
      allowFailure: true,
    });

    // Wait for the descendant pid to be recorded.
    const deadline = Date.now() + 5000;
    let descPid = Number.NaN;
    while (Date.now() < deadline) {
      try {
        descPid = Number(readFileSync(descFile, "utf8").trim());
        if (Number.isInteger(descPid) && descPid > 0) {
          break;
        }
      } catch {
        // not written yet
      }
      await sleepMs(50);
    }
    expect(isAlive(descPid)).toBe(true);

    // Scope teardown: the manager reaps this scope's process groups.
    await manager.removeRuntime({
      entry: { containerName: scopeKey, sessionKey: scopeKey },
      config: {},
    } as unknown as RemoveRuntimeParams);
    await pending.catch(() => {});
    await expectDeadWithin(descPid);
  });
});
