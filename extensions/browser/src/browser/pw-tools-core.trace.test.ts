import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const traceTestState = vi.hoisted(() => ({
  context: null as { tracing: { stop: ReturnType<typeof vi.fn> } } | null,
  rootDir: "",
  traceState: { traceActive: true },
}));

const sessionMocks = vi.hoisted(() => ({
  ensureContextState: vi.fn(() => traceTestState.traceState),
  getPageForTargetId: vi.fn(async () => {
    if (!traceTestState.context) {
      throw new Error("test trace context is missing");
    }
    return { context: () => traceTestState.context };
  }),
}));

vi.mock("./paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths.js")>();
  return { ...actual, DEFAULT_TRACE_DIR: traceTestState.rootDir };
});
vi.mock("./pw-session.js", () => sessionMocks);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-browser-trace-test-"));
traceTestState.rootDir = await fs.realpath(tempRoot);
const { traceStopViaPlaywright } = await import("./pw-tools-core.trace.js");

function installTraceStop(implementation: (options: { path: string }) => Promise<void>) {
  const stop = vi.fn(implementation);
  traceTestState.context = { tracing: { stop } };
  traceTestState.traceState.traceActive = true;
  return stop;
}

const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "tab-1" };
const outputPath = (name: string) => path.join(traceTestState.rootDir, name);
const stopTrace = (name: string) => traceStopViaPlaywright({ ...target, path: outputPath(name) });
function expectStopped(stop: ReturnType<typeof vi.fn>, active: boolean) {
  expect(stop).toHaveBeenCalledOnce();
  expect(traceTestState.traceState.traceActive).toBe(active);
}

describe("traceStopViaPlaywright", () => {
  beforeEach(async () => {
    await fs.rm(traceTestState.rootDir, { recursive: true, force: true });
    await fs.mkdir(traceTestState.rootDir, { recursive: true });
    traceTestState.context = null;
    traceTestState.traceState.traceActive = true;
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await fs.rm(traceTestState.rootDir, { recursive: true, force: true });
  });

  it("returns fs-safe's sanitized committed path from a real temporary output root", async () => {
    const requestedPath = outputPath("trace-\u0001.zip");
    const stop = installTraceStop(async ({ path: stagingPath }) => {
      await fs.writeFile(stagingPath, "trace payload", "utf8");
    });

    const committedPath = await stopTrace("trace-\u0001.zip");

    expect(committedPath).not.toBe(requestedPath);
    expect(path.dirname(committedPath)).toBe(traceTestState.rootDir);
    await expect(fs.readFile(committedPath, "utf8")).resolves.toBe("trace payload");
    await expect(fs.access(requestedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expectStopped(stop, false);
  });

  it("clears trace state when Playwright stops before publication later fails", async () => {
    const stop = installTraceStop(async ({ path: stagingPath }) => {
      await fs.writeFile(stagingPath, "trace payload", "utf8");
      await fs.unlink(stagingPath);
    });

    await expect(stopTrace("publication-failure.zip")).rejects.toBeInstanceOf(Error);
    expectStopped(stop, false);
  });

  it("preserves trace state when Playwright stop itself rejects", async () => {
    const stopError = new Error("Playwright trace stop failed");
    const stop = installTraceStop(async () => {
      throw stopError;
    });

    await expect(stopTrace("stop-failure.zip")).rejects.toBe(stopError);
    expectStopped(stop, true);
  });
});
