import type * as AgentHarnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import type * as AgentSessions from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, expect, it, vi } from "vitest";
import { runAcpHarnessAttempt } from "./harness-attempt.js";
import type { CompleteAcpRuntime } from "./runtime-proxy.js";

const registered = vi.hoisted(() => ({
  handle: undefined as undefined | { ownsLiveness?: () => boolean },
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentHarnessRuntime>()),
  setActiveEmbeddedRun: (_sessionId: string, handle: { ownsLiveness?: () => boolean }) => {
    registered.handle = handle;
    return undefined;
  },
  clearActiveEmbeddedRun: () => undefined,
}));
vi.mock("openclaw/plugin-sdk/agent-sessions", async (importOriginal) => {
  const original = await importOriginal<typeof AgentSessions>();
  return {
    ...original,
    SessionManager: Object.assign(Object.create(original.SessionManager), {
      openModelContextAsync: async () => ({
        getBranch: () => [],
        buildSessionContext: () => ({ messages: [] }),
      }),
    }),
  };
});

afterEach(() => {
  vi.useRealTimers();
});

// The host's stalled-run watchdog spares an ACP attempt only while its handle owns liveness.
// Setup before the prompt starts must stay under that watchdog; the attempt's own timer still
// reaps an agent that never answers.
it("leaves pre-prompt setup to the host watchdog and reaps a hung session with its own timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let sessionRequested!: () => void;
  const requested = new Promise<void>((resolve) => {
    sessionRequested = resolve;
  });
  const runtime = {
    // A session that never opens: the prompt never starts.
    ensureSession: () => {
      sessionRequested();
      return new Promise<never>(() => {});
    },
  } as unknown as CompleteAcpRuntime;
  const onAttemptTimeout = vi.fn();
  const input = {
    agentId: "main",
    sessionKey: "agent:main:acp-liveness",
    sessionId: "acp-liveness",
    sessionFile: "acp-liveness.jsonl",
    runId: "acp-liveness-run",
    timeoutMs: 60_000,
    workspaceDir: process.cwd(),
    config: {},
    userTurnTranscriptRecorder: {},
    hostCapabilities: { assertActive: () => undefined },
    onAttemptTimeout,
  } as unknown as Parameters<typeof runAcpHarnessAttempt>[0]["input"];
  const attempt = runAcpHarnessAttempt({
    input,
    runtime,
    agent: "fixture",
    harnessId: "acpx",
    label: "Fixture ACP",
    command: ["fixture-acp"],
    generationSignal: new AbortController().signal,
  }).catch(() => undefined);
  await requested;
  const duringSetup = registered.handle?.ownsLiveness?.();
  vi.advanceTimersByTime(60_000);
  expect(onAttemptTimeout).toHaveBeenCalledOnce();
  const afterTimeout = registered.handle?.ownsLiveness?.();
  expect([duringSetup, afterTimeout]).toEqual([false, false]);
  void attempt;
});
