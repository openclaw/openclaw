import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import type { ProcessSession } from "./bash-process-registry.js";
import {
  acknowledgeNotifyOnExit,
  addSession,
  appendOutput,
  clearFinishedSessionsForScopes,
  deleteSession,
  getActiveBackgroundExecSessionCount,
  getFinishedSession,
  isProcessSessionIdTaken,
  listFinishedSessions,
  listRunningSessions,
  markBackgrounded,
  markExited,
  prepareSessionPoll,
  recordNotifyOnExitRemoval,
  tail,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createSessionSlug } from "./session-slug.js";

const drainSession = (session: ProcessSession) => prepareSessionPoll(session, undefined);

const randomMocks = vi.hoisted(() => ({ generateSecureInt: vi.fn(() => 0) }));

// mock-isolation: Deterministic session IDs exercise collision handling without real randomness.
vi.mock("../infra/secure-random.js", () => ({ generateSecureInt: randomMocks.generateSecureInt }));

it("releases discarded backing strings from live, finished, and staged output", async ({
  signal,
}) => {
  const result = await runNodeScript(
    [
      "--expose-gc",
      "--import",
      "./scripts/tsx.mjs",
      fileURLToPath(new URL("./bash-process-registry.retention.test-support.ts", import.meta.url)),
    ],
    process.env,
    undefined,
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), signal },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, [result.stdout, result.stderr].join("\n")).toBe(0);
});

function makeSession(
  params: Partial<Parameters<typeof createProcessSessionFixture>[0]> = {},
): ProcessSession {
  const session = createProcessSessionFixture({
    id: "sess",
    command: "echo test",
    maxOutputChars: 100,
    pendingMaxOutputChars: 30_000,
    backgrounded: true,
    ...params,
  });
  addSession(session);
  return session;
}

function finishOutput(id: string, size: number, output: string) {
  const session = makeSession({ id, maxOutputChars: size, pendingMaxOutputChars: size });
  appendOutput(session, "stdout", output);
  markExited(session, 0, null, "completed");
}

afterEach(() => {
  resetProcessRegistryForTests();
  vi.useRealTimers();
});

beforeEach(() => {
  randomMocks.generateSecureInt.mockReset();
  randomMocks.generateSecureInt.mockReturnValue(0);
  resetProcessRegistryForTests();
});

it("suppresses a notify-on-exit event when terminal poll acknowledgement wins the race", () => {
  const session = makeSession({ id: "poll-first" });
  markExited(session, 0, null, "completed");
  acknowledgeNotifyOnExit(session);

  const remove = vi.fn(() => true);
  recordNotifyOnExitRemoval(session, remove);

  expect(remove).toHaveBeenCalledOnce();
  expect(getFinishedSession("poll-first")?.terminalPollObserved).toBe(true);
  acknowledgeNotifyOnExit(getFinishedSession("poll-first") ?? {});
  expect(remove).toHaveBeenCalledOnce();
});

const out = (text: string) => ["stdout", text] as const;
const err = (text: string) => ["stderr", text] as const;
const alternating = (...pairs: [string, string][]) =>
  pairs.flatMap(([error, output]) => [err(error), out(output)]);
it.each(
  [
    {
      name: "partial eviction",
      cap: 10,
      chunks: [out("aaaaaa"), err("ERR-safe\n"), out("bbbbbb")],
      pendingChars: 10,
      otherChars: 9,
      expected: "aaaaERR-safe\nbbbbbb",
    },
    {
      name: "multiple whole evictions",
      cap: 6,
      chunks: alternating(["<", "aa"], ["|", "bb"], [">", "cc"], ["!", "dddd"]),
      pendingChars: 6,
      otherChars: 4,
      expected: "<|>cc!dddd",
    },
    {
      name: "whole eviction followed by a UTF-16 boundary cut",
      cap: 7,
      chunks: [err("<"), out("aa"), err("|"), out("a🎉bc"), err(">"), out("dddd")],
      pendingChars: 6,
      otherChars: 3,
      expected: "<|bc>dddd",
    },
  ].flatMap((testCase) =>
    (["stdout", "stderr"] as const).map((stream) => ({ name: testCase.name, testCase, stream })),
  ),
)("keeps callback order after $name from $stream", ({ testCase, stream }) => {
  const { cap, chunks, pendingChars, otherChars, expected } = testCase;
  const session = makeSession({ pendingMaxOutputChars: cap });
  const otherStream = stream === "stdout" ? "stderr" : "stdout";
  for (const [source, text] of chunks) {
    appendOutput(session, source === "stdout" ? stream : otherStream, text);
  }
  expect(session).toMatchObject({
    pendingStdoutChars: stream === "stdout" ? pendingChars : otherChars,
    pendingStderrChars: stream === "stderr" ? pendingChars : otherChars,
  });
  expect(drainSession(session)).toMatchObject({ output: expected, outputDropped: true });
  expect(session).toMatchObject({ pendingStdoutChars: 0, pendingStderrChars: 0 });
});

it("keeps aggregate, pending, and tail suffix cuts on UTF-16 boundaries", () => {
  const session = makeSession({ maxOutputChars: 3, pendingMaxOutputChars: 3 });

  appendOutput(session, "stdout", "a🎉bc");

  expect(session).toMatchObject({ aggregated: "bc", pendingStdoutChars: 2 });
  expect(drainSession(session).output).toBe("bc");
  expect(tail("a🎉bc", 3)).toBe("bc");
});

it("only persists finished sessions when backgrounded", () => {
  const session = makeSession({ backgrounded: false });

  markExited(session, 0, null, "completed");
  expect(listFinishedSessions()).toHaveLength(0);
  expect(session.endedAt).toBeUndefined();

  markBackgrounded(session);
  markExited(session, 0, null, "completed");
  const finishedSessions = listFinishedSessions();
  const endedAt = finishedSessions[0]?.endedAt;
  expect(endedAt).toEqual(expect.any(Number));
  expect(finishedSessions).toEqual([session]);
  expect(session.terminalStatus).toBe("completed");
  deleteSession(session.id);
  expect(session.endedAt).toBe(endedAt);
  expect(listFinishedSessions()).toHaveLength(0);
});

it("evicts the oldest finished sessions when their count exceeds the retention limit", () => {
  for (let index = 0; index < 53; index += 1) {
    finishOutput(`finished-${index}`, 100, `output-${index}`);
  }

  expect(listFinishedSessions()).toHaveLength(50);
  expect(getFinishedSession("finished-0")).toBeUndefined();
  expect(getFinishedSession("finished-2")).toBeUndefined();
  expect(getFinishedSession("finished-3")?.aggregated).toBe("output-3");
  expect(getFinishedSession("finished-52")?.aggregated).toBe("output-52");
});

it("bounds aggregate finished-session output without truncating retained logs", () => {
  for (let index = 0; index < 11; index += 1) {
    finishOutput(`large-finished-${index}`, 250_000, String(index).repeat(250_000));
  }

  expect(listFinishedSessions()).toHaveLength(8);
  expect(getFinishedSession("large-finished-2")).toBeUndefined();
  expect(getFinishedSession("large-finished-3")?.aggregated).toBe("3".repeat(250_000));
  expect(getFinishedSession("large-finished-10")?.aggregated).toBe("10".repeat(125_000));
});

it("releases the aggregate budget when a completed session is explicitly cleared", () => {
  for (let index = 0; index < 8; index += 1) {
    finishOutput(`clear-budget-${index}`, 250_000, String(index).repeat(250_000));
  }

  deleteSession("clear-budget-3");

  finishOutput("clear-budget-replacement", 250_000, "r".repeat(250_000));

  expect(listFinishedSessions()).toHaveLength(8);
  expect(getFinishedSession("clear-budget-0")?.aggregated).toBe("0".repeat(250_000));
  expect(getFinishedSession("clear-budget-3")).toBeUndefined();
  expect(getFinishedSession("clear-budget-replacement")?.aggregated).toBe("r".repeat(250_000));
});

it("retains the complete newest log when it alone exceeds the aggregate budget", () => {
  finishOutput("oversized-finished", 2_000_001, "x".repeat(2_000_001));

  expect(listFinishedSessions()).toHaveLength(1);
  expect(getFinishedSession("oversized-finished")?.aggregated).toHaveLength(2_000_001);
});

it("tracks only live backgrounded sessions", () => {
  const session = makeSession({ backgrounded: false });

  expect(getActiveBackgroundExecSessionCount()).toBe(0);

  markBackgrounded(session);
  markBackgrounded(session);
  expect(getActiveBackgroundExecSessionCount()).toBe(1);

  markExited(session, 0, null, "completed");
  expect(getActiveBackgroundExecSessionCount()).toBe(0);

  markBackgrounded(session);
  expect(getActiveBackgroundExecSessionCount()).toBe(0);
});

it.each([false, true])(
  "keeps a hidden active session id reserved until exit (backgrounded=%s)",
  (backgrounded) => {
    const session = makeSession({ id: "amber-atlas", backgrounded: false });

    if (backgrounded) {
      markBackgrounded(session);
    }
    deleteSession(session.id);
    expect(createSessionSlug(isProcessSessionIdTaken)).toBe("amber-atlas-2");

    session.backgrounded = false;
    markExited(session, 0, null, "completed");
    expect(createSessionSlug(isProcessSessionIdTaken)).toBe("amber-atlas");
  },
);

it("resets its own registry after another module instance replaces the global test API", async () => {
  const testApiKey = Symbol.for("openclaw.bashProcessRegistryTestApi");
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const originalTestApi = globalStore[testApiKey];
  makeSession({ id: "original-registry-session" });

  try {
    const registrySpecifier = "./bash-process-registry.js?reset-owner-regression";
    const reloadedRegistry = (await import(
      registrySpecifier
    )) as typeof import("./bash-process-registry.js");
    expect(globalStore[testApiKey]).not.toBe(originalTestApi);
    expect(reloadedRegistry.listRunningSessions()).toEqual([]);

    resetProcessRegistryForTests();
    expect(listRunningSessions()).toEqual([]);
  } finally {
    globalStore[testApiKey] = originalTestApi;
    resetProcessRegistryForTests();
  }
});

it("expires by completion-relative deadlines without retiring captured poll or notification receipts", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-09T00:00:00Z"));
  const long = makeSession({ id: "long", cleanupMs: 4 * 60 * 60 * 1000 });
  const short = makeSession({ id: "short", cleanupMs: 0 });
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(120_000);
  expect(getFinishedSession(short.id)).toBeUndefined();
  // Completion order does not imply expiry order when agent durations differ.
  markExited(long, 0, null, "completed");
  vi.advanceTimersByTime(10_000);
  appendOutput(short, "stdout", "retained poll output");
  markExited(short, 0, null, "completed");
  const endedAt = short.endedAt;
  const expiresAt = short.expiresAt;
  const remove = vi.fn(() => true);
  recordNotifyOnExitRemoval(short, remove);
  const delivery = prepareSessionPoll(short, {});
  expect(delivery.output).toBe("retained poll output");
  expect(long.expiresAt! - long.endedAt!).toBe(3 * 60 * 60 * 1000);
  expect(short.expiresAt! - short.endedAt!).toBe(60_000);
  expect(getFinishedSession(short.id)).toBe(short);
  expect(vi.getTimerCount()).toBe(1);

  vi.advanceTimersByTime(60_000);
  expect(getFinishedSession(short.id)).toBeUndefined();
  expect(getFinishedSession(long.id)).toBe(long);
  expect(short).toMatchObject({
    endedAt,
    expiresAt,
    pendingPollDelivery: { output: "retained poll output" },
  });
  expect(remove).not.toHaveBeenCalled();
  delivery.acknowledge();
  acknowledgeNotifyOnExit(short);
  expect(remove).toHaveBeenCalledOnce();

  vi.advanceTimersByTime(3 * 60 * 60 * 1000 - 70_000);
  expect(listFinishedSessions()).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["delete", "scope", "reset"] as const)(
  "retires its timer after %s removes retained results",
  (removal) => {
    vi.useFakeTimers();
    const first = makeSession({ id: "first", cleanupMs: 60_000 });
    const last = makeSession({ id: "last", cleanupMs: 180_000 });
    last.scopeKey = "retired";
    markExited(first, 0, null, "completed");
    markExited(last, 0, null, "completed");
    deleteSession(first.id);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(getFinishedSession(last.id)).toBe(last);
    if (removal === "delete") {
      deleteSession(last.id);
    } else if (removal === "scope") {
      clearFinishedSessionsForScopes(["retired"]);
    } else {
      resetProcessRegistryForTests();
    }
    expect(listFinishedSessions()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);
