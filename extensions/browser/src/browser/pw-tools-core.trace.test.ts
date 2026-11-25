import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";

const traceTestState = vi.hoisted(() => ({
  stop: vi.fn<(options: { path: string }) => Promise<void>>(),
  rootDir: "",
  traceState: { traceActive: true },
}));

const sessionMocks = vi.hoisted(() => ({
  ensureContextState: vi.fn(() => traceTestState.traceState),
  getPageForTargetId: vi.fn(async () => ({
    context: () => ({ tracing: { stop: traceTestState.stop } }),
  })),
}));

vi.mock("./paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paths.js")>();
  return { ...actual, DEFAULT_TRACE_DIR: traceTestState.rootDir };
});
vi.mock("./pw-session.js", () => sessionMocks);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-browser-trace-test-"));
traceTestState.rootDir = await fs.realpath(tempRoot);
const { traceStopViaPlaywright } = await import("./pw-tools-core.trace.js");

const target = { cdpUrl: "http://127.0.0.1:18792", targetId: "tab-1" };
const outputPath = (name: string) => path.join(traceTestState.rootDir, name);
const stopTrace = (name: string) => traceStopViaPlaywright({ ...target, path: outputPath(name) });
function expectStopped(active: boolean) {
  expect(traceTestState.stop).toHaveBeenCalledOnce();
  expect(traceTestState.traceState.traceActive).toBe(active);
}

beforeEach(async () => {
  await fs.rm(traceTestState.rootDir, { recursive: true, force: true });
  await fs.mkdir(traceTestState.rootDir, { recursive: true });
  traceTestState.traceState.traceActive = true;
  vi.clearAllMocks();
  traceTestState.stop.mockReset().mockImplementation(async ({ path: stagingPath }) => {
    await fs.writeFile(stagingPath, "trace payload", "utf8");
  });
});

afterAll(async () => {
  await fs.rm(traceTestState.rootDir, { recursive: true, force: true });
});

it("returns fs-safe's sanitized committed path from a real temporary output root", async () => {
  const requestedPath = outputPath("trace-\u0001.zip");
  const committedPath = await stopTrace("trace-\u0001.zip");

  expect(committedPath).not.toBe(requestedPath);
  expect(path.dirname(committedPath)).toBe(traceTestState.rootDir);
  await expect(fs.readFile(committedPath, "utf8")).resolves.toBe("trace payload");
  await expect(fs.access(requestedPath)).rejects.toMatchObject({ code: "ENOENT" });
  expectStopped(false);
});

it("clears trace state when Playwright stops before publication later fails", async () => {
  traceTestState.stop.mockImplementationOnce(async ({ path: stagingPath }) => {
    await fs.writeFile(stagingPath, "trace payload", "utf8");
    await fs.unlink(stagingPath);
  });

  await expect(stopTrace("publication-failure.zip")).rejects.toBeInstanceOf(Error);
  expectStopped(false);
});

it("preserves trace state when Playwright stop itself rejects", async () => {
  const stopError = new Error("Playwright trace stop failed");
  traceTestState.stop.mockRejectedValueOnce(stopError);

  await expect(stopTrace("stop-failure.zip")).rejects.toBe(stopError);
  expectStopped(true);
});
