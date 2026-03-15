import { afterEach, expect, test } from "vitest";
import { getFinishedSession, resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec.js";

/**
 * Regression tests for openclaw/openclaw#30711:
 * stdout lost when a backgrounded process produces block-buffered output
 * that is only flushed at exit.
 */

const POLL_INTERVAL_MS = 15;
const FINISHED_WAIT_TIMEOUT_MS = process.platform === "win32" ? 8_000 : 3_000;
const TEST_EXEC_DEFAULTS = {
  security: "full" as const,
  ask: "off" as const,
};

const createTestExecTool = (
  defaults?: Parameters<typeof createExecTool>[0],
): ReturnType<typeof createExecTool> => createExecTool({ ...TEST_EXEC_DEFAULTS, ...defaults });

afterEach(() => {
  resetProcessRegistryForTests();
});

async function waitForFinishedSession(sessionId: string) {
  let finished = getFinishedSession(sessionId);
  await expect
    .poll(
      () => {
        finished = getFinishedSession(sessionId);
        return Boolean(finished);
      },
      {
        timeout: FINISHED_WAIT_TIMEOUT_MS,
        interval: POLL_INTERVAL_MS,
      },
    )
    .toBe(true);
  return finished;
}

test("backgrounded process stdout is captured when output is flushed at exit", async () => {
  // Simulate a process that delays, then produces output, then exits.
  // This mimics block-buffered stdout where all output is flushed at process exit.
  const marker = `STDOUT_MARKER_${Date.now()}`;
  const tool = createTestExecTool({ allowBackground: true, backgroundMs: 10 });
  const result = await tool.execute("toolcall", {
    command: `node -e "setTimeout(() => { process.stdout.write('${marker}\\n'); }, 50)"`,
    yieldMs: 5,
  });

  expect(result.details.status).toBe("running");
  const sessionId = (result.details as { sessionId: string }).sessionId;

  const finished = await waitForFinishedSession(sessionId);
  expect(finished).toBeTruthy();
  expect(finished?.status).toBe("completed");
  expect(finished?.aggregated).toContain(marker);
});

test("backgrounded process captures both stdout and stderr", async () => {
  const stdoutMarker = `OUT_${Date.now()}`;
  const stderrMarker = `ERR_${Date.now()}`;
  const tool = createTestExecTool({ allowBackground: true, backgroundMs: 10 });
  const result = await tool.execute("toolcall", {
    command: `node -e "setTimeout(() => { process.stdout.write('${stdoutMarker}\\n'); process.stderr.write('${stderrMarker}\\n'); }, 50)"`,
    yieldMs: 5,
  });

  expect(result.details.status).toBe("running");
  const sessionId = (result.details as { sessionId: string }).sessionId;

  const finished = await waitForFinishedSession(sessionId);
  expect(finished).toBeTruthy();
  expect(finished?.status).toBe("completed");
  expect(finished?.aggregated).toContain(stdoutMarker);
  expect(finished?.aggregated).toContain(stderrMarker);
});

test("backgrounded process captures large block-buffered output", async () => {
  // Generate output larger than typical pipe buffer to test block-buffered flush
  const tool = createTestExecTool({ allowBackground: true, backgroundMs: 10 });
  const result = await tool.execute("toolcall", {
    command: `node -e "setTimeout(() => { const line = 'x'.repeat(200) + '\\n'; for (let i = 0; i < 50; i++) process.stdout.write(line); process.stdout.write('DONE\\n'); }, 50)"`,
    yieldMs: 5,
  });

  expect(result.details.status).toBe("running");
  const sessionId = (result.details as { sessionId: string }).sessionId;

  const finished = await waitForFinishedSession(sessionId);
  expect(finished).toBeTruthy();
  expect(finished?.status).toBe("completed");
  expect(finished?.aggregated).toContain("DONE");
  // 50 lines of 200 chars = 10000 chars minimum
  expect(finished?.aggregated?.length ?? 0).toBeGreaterThan(5000);
});
