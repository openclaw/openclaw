import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { AgentsApiClient } from "./agentsapi-client.js";
import {
  externalSessionFixture,
  reopenState,
} from "./agentsapi-harness.persistence.test-helpers.js";
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
    ["openai_hosted", "delete"],
    ["self_hosted", "reset"],
  ] as const)(
    "settles a restarted %s binding before %s without discarding failed cleanup or remote history",
    async (environment, operation) => {
      await withOpenClawTestState({ label: "agentsapi-uncontrolled-cleanup" }, async (state) => {
        const fixture = await externalSessionFixture(state);
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
                async (settle) => settle(),
              );
        try {
          fixture.cancel.mockRejectedValueOnce(new Error("Native cancellation unavailable"));
          await expect(cleanup()).rejects.toThrow("Native cancellation unavailable");
          expect(await fixture.openStore().lookup(fixture.params.sessionId)).toEqual(saved);
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
          expect(deleteSession).not.toHaveBeenCalled();
        } finally {
          await harness.dispose();
        }
      });
    },
  );

  it.each([
    { outcome: "rollback", predecessor: false },
    { outcome: "reject", predecessor: true },
    { outcome: "commit", predecessor: true },
  ] as const)(
    "preserves the native binding until a context cut commits: $outcome (predecessor: $predecessor)",
    async ({ outcome, predecessor }) => {
      await withOpenClawTestState({ label: "agentsapi-external-context-reset" }, async (state) => {
        const fixture = await externalSessionFixture(state);
        const harness = fixture.createHarness();
        try {
          expect(await harness.runAttempt(fixture.params)).toMatchObject({
            terminal: { kind: "ok" },
          });
          const saved = await fixture.openStore().lookup(fixture.params.sessionId);
          if (predecessor) {
            await patchSessionEntry({
              ...fixture.params.sessionTarget,
              update: () => ({
                sessionId: "rotated-local-session",
                previousSessionId: fixture.params.sessionId,
              }),
            });
          }
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
            async (settle) => {
              if (outcome === "reject") {
                throw failure;
              }
              await settle(outcome);
              fixture.events.push(outcome);
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
            outcome === "commit" ? ["commit"] : outcome === "rollback" ? ["rollback"] : [],
          );
        } finally {
          await harness.dispose();
        }
      });
    },
  );
}
