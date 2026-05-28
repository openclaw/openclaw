import { afterEach, expect, test, vi } from "vitest";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import {
  addSession,
  appendOutput,
  markExited,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { createProcessTool } from "./bash-tools.process.js";
import { processSchema } from "./bash-tools.schemas.js";

const fakeSecretOutput = "OPENAI_API_KEY=sk-proj-redaction-canary-1234567890";
const fakeFlagSecret = "sk-proj-redaction-canary-abcdefghijklmnopqrstuvwxyz1234567890";

function resultText(result: Awaited<ReturnType<ReturnType<typeof createProcessTool>["execute"]>>) {
  return (result.content[0] as { text?: string }).text ?? "";
}

afterEach(() => {
  resetProcessRegistryForTests();
  resetDiagnosticSessionStateForTest();
});

function createProcessSessionHarness(sessionId: string) {
  const processTool = createProcessTool();
  const session = createProcessSessionFixture({
    id: sessionId,
    command: "test",
    backgrounded: true,
  });
  addSession(session);
  return { processTool, session };
}

function attachWritableStdin(session: ReturnType<typeof createProcessSessionFixture>) {
  session.stdin = {
    write(_data: string, cb?: (err?: Error | null) => void) {
      cb?.();
    },
    end() {},
    destroyed: false,
  };
}

async function pollSession(
  processTool: ReturnType<typeof createProcessTool>,
  callId: string,
  sessionId: string,
  timeout?: number | string,
  signal?: AbortSignal,
) {
  const args = {
    action: "poll",
    sessionId,
    ...(timeout === undefined ? {} : { timeout }),
  } as unknown as Parameters<ReturnType<typeof createProcessTool>["execute"]>[1];
  return processTool.execute(callId, args, signal);
}

function retryMs(result: Awaited<ReturnType<ReturnType<typeof createProcessTool>["execute"]>>) {
  return (result.details as { retryInMs?: number }).retryInMs;
}

function pollStatus(result: Awaited<ReturnType<ReturnType<typeof createProcessTool>["execute"]>>) {
  return (result.details as { status?: string }).status;
}

async function expectCompletedPollWithTimeout(params: {
  sessionId: string;
  callId: string;
  timeout: number | string;
  advanceMs: number;
  assertUnresolvedAtMs?: number;
}) {
  vi.useFakeTimers();
  try {
    const { processTool, session } = createProcessSessionHarness(params.sessionId);

    setTimeout(() => {
      appendOutput(session, "stdout", "done\n");
      markExited(session, 0, null, "completed");
    }, 10);

    const pollPromise = pollSession(processTool, params.callId, params.sessionId, params.timeout);
    if (params.assertUnresolvedAtMs !== undefined) {
      let resolved = false;
      void pollPromise.finally(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(params.assertUnresolvedAtMs);
      expect(resolved).toBe(false);
    }

    await vi.advanceTimersByTimeAsync(params.advanceMs);
    const poll = await pollPromise;
    const details = poll.details as { status?: string; aggregated?: string };
    expect(details.status).toBe("completed");
    expect(details.aggregated ?? "").toContain("done");
  } finally {
    vi.useRealTimers();
  }
}

test("process poll waits for completion when timeout is provided", async () => {
  await expectCompletedPollWithTimeout({
    sessionId: "sess",
    callId: "toolcall",
    timeout: 2000,
    assertUnresolvedAtMs: 200,
    advanceMs: 100,
  });
});

test("process poll accepts string timeout values", async () => {
  await expectCompletedPollWithTimeout({
    sessionId: "sess-2",
    callId: "toolcall",
    timeout: "2000",
    advanceMs: 350,
  });
});

test("process poll ignores partial string timeout values", async () => {
  vi.useFakeTimers();
  try {
    const { processTool } = createProcessSessionHarness("sess-partial-timeout");

    const pollPromise = pollSession(processTool, "toolcall", "sess-partial-timeout", "10ms");

    await expect(pollPromise).resolves.toMatchObject({
      details: expect.objectContaining({ status: "running" }),
    });
  } finally {
    vi.useRealTimers();
  }
});

test("process poll clamps long waits to 30 seconds", async () => {
  vi.useFakeTimers();
  try {
    const { processTool } = createProcessSessionHarness("sess-clamp");

    const pollPromise = pollSession(processTool, "toolcall", "sess-clamp", 120_000);
    let resolved = false;
    void pollPromise.finally(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const poll = await pollPromise;
    expect(pollStatus(poll)).toBe("running");
  } finally {
    vi.useRealTimers();
  }
});

test("process poll schema advertises the 30 second wait cap", () => {
  const timeoutSchema = processSchema.properties.timeout;
  expect((timeoutSchema as { description?: string }).description).toContain("max 30000 ms");
});

test("process poll aborts while waiting for completion", async () => {
  vi.useFakeTimers();
  try {
    const { processTool } = createProcessSessionHarness("sess-abort");
    const controller = new AbortController();

    const pollPromise = pollSession(
      processTool,
      "toolcall",
      "sess-abort",
      30_000,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();

    let err: unknown;
    try {
      await pollPromise;
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");
  } finally {
    vi.useRealTimers();
  }
});

test("process poll redacts secret-shaped output before returning results", async () => {
  const sessionId = "sess-redact-poll";
  const { processTool, session } = createProcessSessionHarness(sessionId);

  appendOutput(session, "stdout", `${fakeSecretOutput}\n`);
  markExited(session, 0, null, "completed");

  const poll = await pollSession(processTool, "toolcall-redact-poll", sessionId);
  const details = poll.details as { aggregated?: string };
  expect(resultText(poll)).not.toContain(fakeSecretOutput);
  expect(details.aggregated).not.toContain(fakeSecretOutput);
  expect(resultText(poll)).toContain("OPENAI_API_KEY=sk-pro…7890");
  expect(details.aggregated).toContain("OPENAI_API_KEY=sk-pro…7890");
});

test("process log redacts secret-shaped output before returning results", async () => {
  const sessionId = "sess-redact-log";
  const { processTool, session } = createProcessSessionHarness(sessionId);

  appendOutput(session, "stdout", `${fakeSecretOutput}\n`);
  const log = await processTool.execute("toolcall-redact-log", {
    action: "log",
    sessionId,
  });

  expect(resultText(log)).not.toContain(fakeSecretOutput);
  expect(resultText(log)).toContain("OPENAI_API_KEY=sk-pro…7890");
});

test("process list redacts secret-shaped command and tail details", async () => {
  const sessionId = "sess-redact-list";
  const processTool = createProcessTool();
  const session = createProcessSessionFixture({
    id: sessionId,
    command: `echo ${fakeSecretOutput}`,
    backgrounded: true,
  });
  addSession(session);
  appendOutput(session, "stdout", `${fakeSecretOutput}\n`);

  const listed = await processTool.execute("toolcall-redact-list", {
    action: "list",
  });
  const details = listed.details as { sessions?: Array<{ command?: string; tail?: string }> };
  const listedSession = details.sessions?.find((entry) =>
    entry.command?.includes("OPENAI_API_KEY"),
  );

  expect(resultText(listed)).not.toContain(fakeSecretOutput);
  expect(JSON.stringify(details)).not.toContain(fakeSecretOutput);
  expect(resultText(listed)).toContain("OPENAI_API_KEY=");
  expect(listedSession?.command).toContain("OPENAI_API_KEY=***");
  expect(listedSession?.tail).toContain("OPENAI_API_KEY=***");
});

test("process write redacts secret-shaped command-derived details name", async () => {
  const sessionId = "sess-redact-write-name";
  const processTool = createProcessTool();
  const session = createProcessSessionFixture({
    id: sessionId,
    command: `echo ${fakeSecretOutput}`,
    backgrounded: true,
  });
  attachWritableStdin(session);
  addSession(session);

  const written = await processTool.execute("toolcall-redact-write-name", {
    action: "write",
    sessionId,
    data: "input\n",
  });
  const details = written.details as { name?: string };

  expect(resultText(written)).not.toContain(fakeSecretOutput);
  expect(JSON.stringify(details)).not.toContain(fakeSecretOutput);
  expect(details.name).toContain("OPENAI_API_KEY=");
});

test("process list, poll, log, and write redact secret-shaped flag values before deriving details name", async () => {
  const sessionId = "sess-redact-flag-name";
  const processTool = createProcessTool();
  const session = createProcessSessionFixture({
    id: sessionId,
    command: `tool --api-key ${fakeFlagSecret}`,
    backgrounded: true,
  });
  attachWritableStdin(session);
  addSession(session);

  const listed = await processTool.execute("toolcall-redact-flag-list", {
    action: "list",
  });
  const polled = await pollSession(processTool, "toolcall-redact-flag-poll", sessionId);
  const logged = await processTool.execute("toolcall-redact-flag-log", {
    action: "log",
    sessionId,
  });
  const written = await processTool.execute("toolcall-redact-flag-write", {
    action: "write",
    sessionId,
    data: "input\n",
  });

  for (const result of [listed, polled, logged, written]) {
    const serialized = JSON.stringify(result.details);
    expect(serialized).not.toContain(fakeFlagSecret);
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
    expect(serialized).toContain("sk-pro…7890");
  }
});

test("process poll exposes adaptive retryInMs for repeated no-output polls", async () => {
  const sessionId = "sess-retry";
  const { processTool } = createProcessSessionHarness(sessionId);

  const polls = await Promise.all([
    pollSession(processTool, "toolcall-1", sessionId),
    pollSession(processTool, "toolcall-2", sessionId),
    pollSession(processTool, "toolcall-3", sessionId),
    pollSession(processTool, "toolcall-4", sessionId),
    pollSession(processTool, "toolcall-5", sessionId),
  ]);

  expect(polls.map((poll) => retryMs(poll))).toEqual([5000, 10000, 30000, 60000, 60000]);
});

test("process poll resets retryInMs when output appears and clears on completion", async () => {
  const sessionId = "sess-reset";
  const { processTool, session } = createProcessSessionHarness(sessionId);

  const poll1 = await pollSession(processTool, "toolcall-1", sessionId);
  const poll2 = await pollSession(processTool, "toolcall-2", sessionId);
  expect(retryMs(poll1)).toBe(5000);
  expect(retryMs(poll2)).toBe(10000);

  appendOutput(session, "stdout", "step complete\n");
  const pollWithOutput = await pollSession(processTool, "toolcall-output", sessionId);
  expect(retryMs(pollWithOutput)).toBe(5000);

  markExited(session, 0, null, "completed");
  const pollCompleted = await pollSession(processTool, "toolcall-completed", sessionId);
  expect(pollStatus(pollCompleted)).toBe("completed");
  expect(retryMs(pollCompleted)).toBeUndefined();

  const pollFinished = await pollSession(processTool, "toolcall-finished", sessionId);
  expect(pollStatus(pollFinished)).toBe("completed");
  expect(retryMs(pollFinished)).toBeUndefined();
});
