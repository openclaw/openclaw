import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsApiClient } from "./agentsapi-client.js";
import { createCompletedSessionFactory } from "./agentsapi-harness.persistence.test-helpers.js";
import { withPersistenceFixture } from "./agentsapi-persistence-fixture.test-support.js";
import { createTurn } from "./agentsapi.test-support.js";

const { createSession } = vi.hoisted(() => ({
  createSession: vi.fn<typeof import("./agentsapi-session.js").createAgentsApiSession>(),
}));
// Only the initial completed turn is stubbed; stalled continuations use the real session owner.
vi.mock("./agentsapi-session.js", () => ({ createAgentsApiSession: createSession }));
vi.mock("./agentsapi-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agentsapi-prompt.js")>()),
  buildAgentsApiInstructions: async () => "Fixture instructions",
}));

beforeEach(() => {
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

it.each(["reasoning update", "stream connection", "first event", "active native work"])(
  "bounds resumed session startup at %s without discarding its binding",
  async (phase) => {
    await withPersistenceFixture("session-fixture", async (fixture) => {
      await fixture.run();
      const saved = await fixture.openStore().lookup(fixture.params.sessionId);
      await fixture.restart();
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
      if (phase === "reasoning update") {
        fixture.update.mockImplementation((_id, _effort, signal) => wait(signal));
      }
      const turns = vi.spyOn(AgentsApiClient.prototype, "turns").mockResolvedValue([]);
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
      const controller = new AbortController();
      const onAttemptAbort = vi.fn();
      const result = fixture.harness.runAttempt({
        ...fixture.params,
        runId: "resumed-stalled-turn",
        timeoutMs: 600_000,
        abortSignal: controller.signal,
        onAttemptAbort,
      });
      try {
        const signal = await blocked.promise;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(signal.aborted).toBe(phase !== "active native work");
        if (phase === "active native work") {
          controller.abort();
        }
        expect(await result).toMatchObject({
          terminal:
            phase === "active native work"
              ? { kind: "aborted", source: "external" }
              : {
                  kind: "failed",
                  error: {
                    message: expect.stringContaining("Inspect the native session or use /reset"),
                  },
                },
          replayMetadata: {
            hadPotentialSideEffects: phase === "first event" || phase === "active native work",
          },
        });
        expect(cancel).toHaveBeenCalledTimes(
          phase === "first event" || phase === "active native work" ? 1 : 0,
        );
        expect(onAttemptAbort).toHaveBeenCalledTimes(phase === "active native work" ? 1 : 0);
        expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(saved);
        // A recovered service can continue the same persisted conversation after restart.
        createSession.mockImplementation(healthySession);
        fixture.update.mockResolvedValue();
        await fixture.restart();
        await fixture.run({ runId: "recovered-native-turn" });
        expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(saved);
        expect(fixture.create).toHaveBeenCalledTimes(1);
      } finally {
        controller.abort();
        await result;
      }
    });
  },
);
