import { afterEach, expect, test, vi } from "vitest";
import { runMemoryForget } from "./cli-index-search.runtime.js";

const writeJson = vi.hoisted(() => vi.fn());
const forgetMemoryEntries = vi.hoisted(() => vi.fn());
const disableLocalCronJobsBoundToSessions = vi.hoisted(() => vi.fn());
const cfg = vi.hoisted(() => ({}));

vi.mock("openclaw/plugin-sdk/cron-store-runtime", () => ({
  disableLocalCronJobsBoundToSessions,
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", () => ({
  captureRuntimeConfigAsyncReader: () => async () => cfg,
}));
vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-runtime-cli")>()),
  defaultRuntime: { writeJson },
}));
vi.mock("./memory-forget.js", () => ({ forgetMemoryEntries }));

afterEach(() => {
  process.exitCode = 0;
  vi.clearAllMocks();
});

test("memory forget reports bound automation cleanup for resolved sessions", async () => {
  const report = {
    agentId: "main",
    dryRun: false,
    sessionResolutions: [
      { sessionId: "session-one", sessionKey: "agent:main:one", source: "live" },
      { sessionId: "session-two", source: "unresolved" },
    ],
  };
  forgetMemoryEntries.mockResolvedValue(report);
  disableLocalCronJobsBoundToSessions.mockResolvedValue({
    disabledBySession: new Map([["agent:main:one", ["reminder-disabled"]]]),
    failures: [{ jobId: "reminder-failed", message: "synthetic cleanup failure" }],
  });

  await runMemoryForget({ session: ["session-one", "session-two"], json: true });

  expect(disableLocalCronJobsBoundToSessions).toHaveBeenCalledWith({
    cfg,
    sessions: [{ agentId: "main", sessionId: "session-one", sessionKey: "agent:main:one" }],
  });
  expect(writeJson).toHaveBeenCalledWith({
    ...report,
    automationCleanup: {
      disabledJobIds: ["reminder-disabled"],
      failures: [{ jobId: "reminder-failed", message: "synthetic cleanup failure" }],
    },
  });
  expect(process.exitCode).toBe(1);
});
