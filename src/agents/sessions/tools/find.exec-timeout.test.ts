import type { ChildProcess } from "node:child_process";
// Find tool exec-timeout escalation tests run a real managed-bin stub that
// ignores SIGTERM: the deadline must reject the tool call, the kill escalation
// must still reap the child, and its stdio pipes must be destroyed.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { spawnCommand } from "../../../process/exec.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { createFindToolDefinition } from "./find.js";

// Keep the real exec module (real spawn) while capturing spawned children.
vi.mock("../../../process/exec.js", async (importActual) => {
  const actual = (await importActual()) as typeof import("../../../process/exec.js");
  return {
    ...actual,
    spawnCommand: vi.fn(actual.spawnCommand),
  };
});

vi.mock("../../utils/tools-manager.js", () => ({
  ensureTool: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Shebang execution and SIGTERM semantics are POSIX-only.
const describePosix = process.platform === "win32" ? describe.skip : describe;

function writeSigtermIgnoringStub(dir: string): string {
  const stubPath = path.join(dir, "stub-fd");
  fs.writeFileSync(
    stubPath,
    `#!${process.execPath}\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 60_000);\n`,
    { mode: 0o755 },
  );
  return stubPath;
}

function lastSpawnedChild(): ChildProcess & { pid: number } {
  const child = vi.mocked(spawnCommand).mock.results.at(-1)?.value as
    | (ChildProcess & { pid?: number })
    | undefined;
  if (!child || typeof child.pid !== "number") {
    throw new Error("expected spawnCommand to have produced a child with a pid");
  }
  return child as ChildProcess & { pid: number };
}

async function expectProcessReaped(pid: number): Promise<void> {
  await vi.waitFor(
    () => {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    },
    { timeout: 5_000, interval: 25 },
  );
}

describePosix("find tool exec-timeout escalation", () => {
  afterEach(() => {
    // Reap any stub that survived a failing run so the test process cannot
    // hang on open pipes.
    for (const result of vi.mocked(spawnCommand).mock.results) {
      const child = result.value as { pid?: number } | undefined;
      if (typeof child?.pid === "number") {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    vi.clearAllMocks();
  });

  it("rejects at the deadline, reaps a SIGTERM-ignoring fd via escalation, and releases its pipes", async () => {
    const dir = tempDirs.make("openclaw-find-stub-");
    const stubPath = writeSigtermIgnoringStub(dir);
    vi.mocked(ensureTool).mockResolvedValue(stubPath);

    const tool = createFindToolDefinition(dir, { execTimeoutMs: 100 });
    const result = tool.execute("call-1", { pattern: "*.ts" }, undefined, undefined, {} as never);
    await vi.waitFor(() => expect(spawnCommand).toHaveBeenCalledOnce());
    const child = lastSpawnedChild();

    await expect(result).rejects.toThrow(/fd timed out/);
    // Stream cleanup is part of forced settlement: no pipes stay pinned.
    expect(child.stdout?.destroyed).toBe(true);
    expect(child.stderr?.destroyed).toBe(true);
    // The stub ignores SIGTERM, so only the SIGKILL escalation can reap it.
    expect(child.killed).toBe(true);
    await expectProcessReaped(child.pid);
  });
});
