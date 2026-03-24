import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type RunArtifactsModule = typeof import("./run-artifacts.js");

const tempDirs = new Set<string>();

async function createTempStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acpx-run-artifacts-"));
  tempDirs.add(dir);
  return dir;
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:fs/promises");
  delete process.env.OPENCLAW_STATE_DIR;
  await Promise.all(Array.from(tempDirs, (dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe("run-artifacts", () => {
  it("preserves terminal truth when route mirror write fails", async () => {
    const stateDir = await createTempStateDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const actualFs = (await vi.importActual(
      "node:fs/promises",
    )) as typeof import("node:fs/promises");
    let routeRenameCount = 0;

    vi.doMock("node:fs/promises", async () => ({
      ...actualFs,
      rename: vi.fn(async (from: string, to: string) => {
        if (to.endsWith("/route.json")) {
          routeRenameCount += 1;
          if (routeRenameCount === 2) {
            const error = new Error("route mirror write failed") as NodeJS.ErrnoException;
            error.code = "EIO";
            throw error;
          }
        }
        return await actualFs.rename(from, to);
      }),
    }));

    const module = (await import("./run-artifacts.js")) as RunArtifactsModule;
    const artifacts = await module.createRunArtifacts({
      requestId: "req-route-mirror-failure",
      sessionKey: "agent:codex:acp:route-mirror-failure",
      runtimeSessionName: "agent:codex:acp:route-mirror-failure",
      agent: "codex",
      promptMode: "prompt",
      routeKind: "prompt_session",
      routeArgs: ["acpx", "prompt"],
      cwd: process.cwd(),
    });

    await expect(
      module.finalizeRun({
        artifacts,
        state: "completed",
        captureStatus: "captured",
        doneSeen: true,
        syntheticDone: false,
        errorSeen: false,
        exitCode: 0,
        signal: null,
        stdoutBytes: 12,
        stderrBytes: 0,
        stdoutLines: 1,
        stderrLines: 0,
        endedAt: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();

    const terminal = await readJson<Record<string, unknown>>(artifacts.terminalPath);
    const route = await readJson<Record<string, unknown>>(artifacts.routePath);

    expect(terminal.state).toBe("completed");
    expect(terminal.capture_status).toBe("captured");
    expect(terminal.result_ref).toBeTruthy();
    expect(route.state).toBe("accepted");
  });

  it("fails immediately when run-id allocation sees a non-EEXIST mkdir error", async () => {
    const stateDir = await createTempStateDir();
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const actualFs = (await vi.importActual(
      "node:fs/promises",
    )) as typeof import("node:fs/promises");
    let candidateMkdirCalls = 0;

    vi.doMock("node:fs/promises", async () => ({
      ...actualFs,
      mkdir: vi.fn(async (target: string, options?: { recursive?: boolean }) => {
        if (options?.recursive === false) {
          candidateMkdirCalls += 1;
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return await actualFs.mkdir(target, options);
      }),
    }));

    const module = (await import("./run-artifacts.js")) as RunArtifactsModule;

    await expect(
      module.createRunArtifacts({
        requestId: "req-mkdir-eacces",
        sessionKey: "agent:codex:acp:mkdir-eacces",
        runtimeSessionName: "agent:codex:acp:mkdir-eacces",
        agent: "codex",
        promptMode: "prompt",
        routeKind: "prompt_session",
        routeArgs: ["acpx", "prompt"],
        cwd: process.cwd(),
      }),
    ).rejects.toMatchObject({
      code: "EACCES",
    });

    expect(candidateMkdirCalls).toBe(1);
  });
});
