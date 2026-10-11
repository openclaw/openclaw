import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { AgentsApiClient } from "./agentsapi-client.js";
import { executorFixture, reopenState } from "./agentsapi-harness.persistence.test-helpers.js";
import { createHostedSession } from "./agentsapi.test-support.js";

/** Shares the persistence suite's admitted database and mocked native execution. */
export function registerNativeLifecycleTests(
  resolveProviderAuth: ReturnType<
    typeof vi.fn<
      typeof import("openclaw/plugin-sdk/provider-auth-runtime").resolveApiKeyForProvider
    >
  >,
) {
  it.each([
    ["openai_hosted", "reset"],
    ["openai_hosted", "delete"],
    ["self_hosted", "reset"],
    ["self_hosted", "delete"],
  ] as const)(
    "settles a restarted %s binding before %s without discarding failed cleanup or remote history",
    async (environment, operation) => {
      await withOpenClawTestState({ label: "agentsapi-uncontrolled-cleanup" }, async (state) => {
        const fixture = await executorFixture(state);
        // This is the existing persisted format: no executor or credential metadata.
        const saved = { sessionId: fixture.nativeSession.id, configFingerprint: "saved-config" };
        await fixture.openStore().register(fixture.params.sessionId, saved);
        await reopenState();
        fixture.session.mockResolvedValue({
          ...fixture.nativeSession,
          status: "in_progress",
          environment:
            environment === "openai_hosted"
              ? createHostedSession().environment
              : fixture.nativeSession.environment,
        });
        vi.mocked(fixture.runtime.agent.resolveAgentDir).mockReturnValue("/gateway/agents/main");
        vi.mocked(fixture.runtime.agent.resolveAgentWorkspaceDir).mockReturnValue(
          "/gateway/workspace",
        );
        const deleteSession = vi
          .spyOn(AgentsApiClient.prototype, "deleteSession")
          .mockResolvedValue();
        const harness = fixture.createHarness();
        const cleanup = () =>
          operation === "reset"
            ? harness.reset({ ...fixture.params.sessionTarget, reason: "reset" })
            : harness.withSessionDeletion(
                { ...fixture.params.sessionTarget, assertCurrent: () => {} },
                async (mutation) => mutation.commit(),
              );
        try {
          fixture.cancel.mockRejectedValueOnce(new Error("Native cancellation unavailable"));
          await expect(cleanup()).rejects.toThrow("Native cancellation unavailable");
          expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(saved);
          expect(fixture.controller.retire).not.toHaveBeenCalled();
          await cleanup();
          expect((await fixture.openStore().lookup(fixture.params.sessionId)) ?? {}).toEqual({});
          expect(resolveProviderAuth).toHaveBeenLastCalledWith(
            expect.objectContaining({
              provider: "openai",
              agentDir: "/gateway/agents/main",
              workspaceDir: "/gateway/workspace",
            }),
          );
          expect(fixture.runtime.agent.resolveAgentDir).toHaveBeenLastCalledWith(
            expect.any(Object),
            "main",
          );
          expect(fixture.cancel).toHaveBeenCalledTimes(2);
          expect(fixture.controller.retire).not.toHaveBeenCalled();
          expect(deleteSession).not.toHaveBeenCalled();
        } finally {
          await harness.dispose();
        }
      });
    },
  );

  it.each([
    { outcome: "commit", predecessor: false },
    { outcome: "rollback", predecessor: false },
    { outcome: "reject", predecessor: true },
    { outcome: "commit", predecessor: true },
  ] as const)(
    "retires the context-cut executor only after $outcome (predecessor: $predecessor)",
    async ({ outcome, predecessor }) => {
      await withOpenClawTestState({ label: "agentsapi-executor-context-reset" }, async (state) => {
        const fixture = await executorFixture(state);
        const harness = fixture.createHarness();
        try {
          expect(await harness.runAttempt(fixture.params)).toMatchObject({
            terminal: { kind: "ok" },
          });
          const saved = await fixture.openStore().lookup(fixture.params.sessionId);
          fixture.events.length = 0;
          const failure = new Error("History cut rejected");
          const result = harness.withSessionContextReset(
            {
              ...fixture.params.sessionTarget,
              ...(predecessor
                ? {
                    sessionId: "rotated-local-session",
                    previousSessionId: fixture.params.sessionId,
                  }
                : {}),
              assertCurrent: () => {},
            },
            async (mutation) => {
              expect(fixture.controller.retire).not.toHaveBeenCalled();
              if (outcome === "reject") {
                throw failure;
              }
              mutation.commit();
              fixture.events.push("commit");
              if (outcome === "rollback") {
                mutation.rollback();
                fixture.events.push("rollback");
              }
              expect(fixture.controller.retire).not.toHaveBeenCalled();
            },
          );
          if (outcome === "reject") {
            await expect(result).rejects.toBe(failure);
          } else {
            await result;
          }
          expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(
            outcome === "commit" ? undefined : saved,
          );
          expect(fixture.events).toEqual(
            outcome === "commit"
              ? ["commit", "retire"]
              : outcome === "rollback"
                ? ["commit", "rollback"]
                : [],
          );
          if (outcome === "commit") {
            expect(fixture.controller.retire).toHaveBeenCalledExactlyOnceWith(
              saved?.executor,
              expect.objectContaining({ assertCurrent: expect.any(Function) }),
            );
          }
        } finally {
          await harness.dispose();
        }
      });
    },
  );
}
