import type * as AgentHarnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import type * as AgentSessions from "openclaw/plugin-sdk/agent-sessions";
import { expect, it, vi } from "vitest";
import { runAcpHarnessAttempt } from "./harness-attempt.js";
import type { CompleteAcpRuntime } from "./runtime-proxy.js";

const registered = vi.hoisted(() => ({
  handle: undefined as undefined | { ownsLiveness?: () => boolean },
  atRegistration: undefined as boolean | undefined,
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentHarnessRuntime>()),
  setActiveEmbeddedRun: (_sessionId: string, handle: { ownsLiveness?: () => boolean }) => {
    registered.handle = handle;
    registered.atRegistration = handle.ownsLiveness?.();
    return undefined;
  },
  clearActiveEmbeddedRun: () => undefined,
}));
vi.mock("openclaw/plugin-sdk/agent-sessions", async (importOriginal) => {
  const original = await importOriginal<typeof AgentSessions>();
  return {
    ...original,
    SessionManager: Object.assign(Object.create(original.SessionManager), {
      openModelContextAsync: async () => {
        throw new Error("fixture transcript unavailable");
      },
    }),
  };
});

// The host's stalled-run watchdog spares an ACP turn only while its handle owns liveness;
// the attempt's own timer still reaps a stuck agent.
it("owns liveness from registration until the ACP attempt settles", async () => {
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
  } as unknown as Parameters<typeof runAcpHarnessAttempt>[0]["input"];
  await runAcpHarnessAttempt({
    input,
    runtime: {} as CompleteAcpRuntime,
    agent: "fixture",
    harnessId: "acpx",
    label: "Fixture ACP",
    command: ["fixture-acp"],
    generationSignal: new AbortController().signal,
  }).catch(() => undefined);
  expect([registered.atRegistration, registered.handle?.ownsLiveness?.()]).toEqual([true, false]);
});
