import { afterEach, expect, test } from "vitest";
import { sleep } from "../utils.ts";
import {
  getFinishedSession,
  getSession,
  resetProcessRegistryForTests,
} from "./bash-process-registry";
import { createExecTool } from "./bash-tools.exec";
import { killProcessTree } from "./shell-utils";

afterEach(() => {
  resetProcessRegistryForTests();
});

async function waitForFinishedSession(sessionId: string) {
  let finished = getFinishedSession(sessionId);
  const deadline = Date.now() + (process.platform === "win32" ? 10_000 : 2_000);
  while (!finished && Date.now() < deadline) {
    await sleep(20);
    finished = getFinishedSession(sessionId);
  }
  return finished;
}

function cleanupRunningSession(sessionId: string) {
  const running = getSession(sessionId);
  const pid = running?.pid;
  if (pid) {
    killProcessTree(pid);
  }
  return running;
}

async function expectBackgroundSessionSurvivesAbort(params: {
  tool: ReturnType<typeof createExecTool>;
  executeParams: Record<string, unknown>;
}) {
  const abortController = new AbortController();
  const result = await params.tool.execute(
    "toolcall",
    params.executeParams,
    abortController.signal,
  );
  expect(result.details.status).toBe("running");
  const sessionId = (result.details as { sessionId: string }).sessionId;

  abortController.abort();
  await sleep(150);

  const running = getSession(sessionId);
  const finished = getFinishedSession(sessionId);
  try {
    expect(finished).toBeUndefined();
    expect(running?.exited).toBe(false);
  } finally {
    cleanupRunningSession(sessionId);
  }
}

async function expectBackgroundSessionTimesOut(params: {
  tool: ReturnType<typeof createExecTool>;
  executeParams: Record<string, unknown>;
  signal?: AbortSignal;
  abortAfterStart?: boolean;
}) {
  const abortController = new AbortController();
  const signal = params.signal ?? abortController.signal;
  const result = await params.tool.execute("toolcall", params.executeParams, signal);
  expect(result.details.status).toBe("running");
  const sessionId = (result.details as { sessionId: string }).sessionId;

  if (params.abortAfterStart) {
    abortController.abort();
  }

  const finished = await waitForFinishedSession(sessionId);
  try {
    expect(finished).toBeTruthy();
    expect(finished?.status).toBe("failed");
  } finally {
    cleanupRunningSession(sessionId);
  }
}

test("background exec is not killed when tool signal aborts", async () => {
  const tool = createExecTool({ allowBackground: true, backgroundMs: 0 });
  await expectBackgroundSessionSurvivesAbort({
    tool,
    executeParams: { command: 'node -e "setTimeout(() => {}, 5000)"', background: true },
  });
});

test("pty background exec is not killed when tool signal aborts", async () => {
  const tool = createExecTool({ allowBackground: true, backgroundMs: 0 });
  await expectBackgroundSessionSurvivesAbort({
    tool,
    executeParams: { command: 'node -e "setTimeout(() => {}, 5000)"', background: true, pty: true },
  });
});

test("background exec still times out after tool signal abort", async () => {
  const tool = createExecTool({ allowBackground: true, backgroundMs: 0 });
  await expectBackgroundSessionTimesOut({
    tool,
    executeParams: {
      command: 'node -e "setTimeout(() => {}, 5000)"',
      background: true,
      timeout: 0.2,
    },
    abortAfterStart: true,
  });
});

test("yielded background exec is not killed when tool signal aborts", async () => {
  const tool = createExecTool({ allowBackground: true, backgroundMs: 10 });
  await expectBackgroundSessionSurvivesAbort({
    tool,
    executeParams: { command: 'node -e "setTimeout(() => {}, 5000)"', yieldMs: 5 },
  });
});

test("yielded background exec still times out", async () => {
  const tool = createExecTool({ allowBackground: true, backgroundMs: 10 });
  await expectBackgroundSessionTimesOut({
    tool,
    executeParams: {
      command: 'node -e "setTimeout(() => {}, 5000)"',
      yieldMs: 5,
      timeout: 0.2,
    },
  });
});
