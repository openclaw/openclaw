import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentsApiBinding } from "./agentsapi-bindings.js";
import { AgentsApiClient } from "./agentsapi-client.js";
import {
  createAttempt,
  createCompletedSessionFactory,
  mockClient,
  registerHarness,
  reopenState,
} from "./agentsapi-harness.persistence.test-helpers.js";
import { createTurn } from "./agentsapi.test-support.js";

const { createSession } = vi.hoisted(() => ({
  createSession: vi.fn<typeof import("./agentsapi-session.js").createAgentsApiSession>(),
}));
// Only the initial completed turn is stubbed; stalled continuations use the real session owner.
vi.mock("./agentsapi-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agentsapi-session.js")>()),
  createAgentsApiSession: createSession,
}));
vi.mock("./agentsapi-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agentsapi-prompt.js")>()),
  buildAgentsApiInstructions: async () => "Fixture instructions",
}));

beforeEach(() => {
  // Keep database lease clocks real while advancing only the harness deadlines.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
  vi.spyOn(AgentsApiClient.prototype, "turn").mockImplementation(async (sessionId, id) =>
    createTurn({ session_id: sessionId, id }),
  );
  vi.spyOn(AgentsApiClient.prototype, "artifacts").mockResolvedValue([]);
  createSession.mockImplementation(createCompletedSessionFactory());
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  createSession.mockReset();
  resetPluginStateStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each([
  "creation",
  "reasoning update",
  "state read",
  "stream connection",
  "first event",
  "active native work",
  "shorter attempt deadline",
])("bounds native startup at %s without discarding its binding", async (phase) => {
  await withOpenClawTestState({ label: "agentsapi-startup" }, async (state) => {
    const params = await createAttempt(state.stateDir);
    const openStore = () =>
      createPluginStateKeyedStoreForTests<AgentsApiBinding>("agentsapi", {
        namespace: "agentsapi-sessions",
        maxEntries: 100_000,
        overflowPolicy: "reject-new",
        env: state.env,
      });
    const client = mockClient("session-fixture");
    let harness = registerHarness(state.env);
    const controller = new AbortController();
    try {
      if (phase !== "creation") {
        expect(await harness.runAttempt(params)).toMatchObject({ terminal: { kind: "ok" } });
        await harness.dispose();
        await reopenState();
        harness = registerHarness(state.env);
      }
      const saved = await openStore().lookup(params.sessionId);
      if (phase !== "creation") {
        expect(saved).toMatchObject({ sessionId: "session-fixture" });
      } else {
        expect(saved).toBeUndefined();
      }
      const actual =
        await vi.importActual<typeof import("./agentsapi-session.js")>("./agentsapi-session.js");
      const healthySession = createSession.getMockImplementation()!;
      createSession.mockImplementation(actual.createAgentsApiSession);
      const blocked = createDeferred<AbortSignal>();
      const wait = (signal: AbortSignal) => {
        blocked.resolve(signal);
        return new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Native request aborted")), {
            once: true,
          });
        });
      };
      if (phase === "creation") {
        client.create.mockImplementation((signal) => wait(signal));
      } else if (phase === "reasoning update") {
        client.update.mockImplementation((_id, _effort, signal) => wait(signal));
      }
      const turns = vi.spyOn(AgentsApiClient.prototype, "turns").mockResolvedValue([]);
      if (phase === "state read") {
        turns.mockImplementationOnce((_id, signal) => wait(signal));
      }
      vi.spyOn(AgentsApiClient.prototype, "subscribe").mockImplementation(async (_id, signal) => {
        if (phase === "stream connection") {
          await wait(signal);
        }
        return (async function* () {
          if (phase === "active native work") {
            yield { type: "agent.session.in_progress" };
          }
          await wait(signal);
        })();
      });
      const cancel = vi.spyOn(AgentsApiClient.prototype, "cancel").mockImplementation(async () => {
        turns.mockResolvedValue([
          createTurn({
            status: "cancelled",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          }),
        ]);
      });
      const shorter = phase === "shorter attempt deadline";
      const active = phase === "active native work";
      const submitted = active || shorter || phase === "first event";
      const onAttemptAbort = vi.fn();
      const result = harness.runAttempt({
        ...params,
        runId: "stalled-native-turn",
        timeoutMs: shorter ? 5_000 : 600_000,
        abortSignal: controller.signal,
        onAttemptAbort,
      });
      try {
        const signal = await blocked.promise;
        await vi.advanceTimersByTimeAsync(shorter ? 4_999 : 119_999);
        expect(signal.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(signal.aborted).toBe(!active);
        if (active) {
          controller.abort();
        }
        const outcome = await result;
        expect(outcome).toMatchObject({
          terminal: active
            ? { kind: "aborted", source: "external" }
            : shorter
              ? { kind: "timeout", source: "runtime" }
              : { kind: "failed", error: expect.any(AgentHarnessPreflightError) },
          replayMetadata: { hadPotentialSideEffects: submitted },
        });
        if (!active && !shorter) {
          expect(outcome).toMatchObject({
            terminal: {
              error: { message: expect.stringContaining("Inspect the native session or use /reset") },
            },
          });
        }
        expect(cancel).toHaveBeenCalledTimes(submitted ? 1 : 0);
        expect(onAttemptAbort).toHaveBeenCalledTimes(active || shorter ? 1 : 0);
        expect(await openStore().lookup(params.sessionId)).toEqual(saved);
        expect(client.create).toHaveBeenCalledTimes(1);
        if (phase !== "creation") {
          // Service recovery continues the same persisted conversation after another restart.
          createSession.mockImplementation(healthySession);
          client.update.mockResolvedValue();
          await harness.dispose();
          await reopenState();
          harness = registerHarness(state.env);
          expect(await harness.runAttempt({ ...params, runId: "recovered-native-turn" })).toMatchObject({
            terminal: { kind: "ok" },
          });
          expect(await openStore().lookup(params.sessionId)).toEqual(saved);
          expect(client.create).toHaveBeenCalledTimes(1);
        }
      } finally {
        controller.abort();
        await result;
      }
    } finally {
      controller.abort();
      await harness.dispose();
    }
  });
});
