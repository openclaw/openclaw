/**
 * Test fixtures for bash process registry state.
 * Provides complete session objects so tests can focus on the field under
 * inspection without repeating registry defaults.
 */
import {
  type ProcessSession,
  registerProcessSession,
  resolveProcessCleanupMs,
} from "./bash-process-registry.js";
import { buildProcessSessionForTests } from "./bash-process-registry.test-support.js";

type ProcessSessionFixtureParams = Partial<
  Omit<ProcessSession, "output" | "aggregated" | "tail" | "pendingOutput" | "cleanupMs">
> & { id: string; cleanupMs?: number };

function fixtureParams({ cleanupMs, ...params }: ProcessSessionFixtureParams) {
  return {
    command: "test",
    scopeKey: "test-scope",
    startedAt: Date.now(),
    cwd: "/tmp",
    maxOutputChars: 10_000,
    pendingMaxOutputChars: 30_000,
    totalOutputChars: 0,
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    pendingOutputDropped: false,
    exited: false,
    exitCode: undefined,
    exitSignal: undefined,
    truncated: false,
    backgrounded: false,
    cursorKeyMode: "normal" as const,
    // An ordinary origin conversation: the exit wakes a turn unless a test opts out.
    notifyOnExit: true,
    notifyOnExitEmptySuccess: true,
    notifySessionTarget: { sessionId: "origin", generation: "origin" },
    ...params,
    cleanupMs: resolveProcessCleanupMs(cleanupMs),
  };
}

/** An unregistered process-session fixture for functions that take a session. */
export function createProcessSessionFixture(params: ProcessSessionFixtureParams): ProcessSession {
  return buildProcessSessionForTests(fixtureParams(params));
}

/** Register a process-session fixture, as a spawn path would. */
export function registerProcessSessionFixture(params: ProcessSessionFixtureParams): ProcessSession {
  return registerProcessSession(fixtureParams(params));
}
