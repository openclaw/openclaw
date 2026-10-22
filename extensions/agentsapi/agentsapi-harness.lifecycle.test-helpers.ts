import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { expect, it, vi, type Mock } from "vitest";
import { AgentsApiClient } from "./agentsapi-client.js";
import { withNativeFixture } from "./agentsapi-persistence-fixture.test-support.js";
import { createHostedSession } from "./agentsapi.test-support.js";

export function registerNativeLifecycleTests(
  resolveProviderAuth: Mock<
    typeof import("openclaw/plugin-sdk/provider-auth-runtime").resolveApiKeyForProvider
  >,
) {
  it.each([
    ["openai_hosted", "delete"],
    ["self_hosted", "reset"],
  ] as const)("retries %s %s cleanup without losing history", async (environment, operation) => {
    await withNativeFixture(async (fixture) => {
      // This is the existing persisted format: no executor or credential metadata.
      const saved = { sessionId: fixture.nativeSession.id, configFingerprint: "saved-config" };
      await fixture.openStore().register(fixture.params.sessionId, saved);
      await fixture.restart();
      fixture.session.mockResolvedValue({
        ...fixture.nativeSession,
        status: "in_progress",
        environment:
          environment === "openai_hosted"
            ? createHostedSession().environment
            : fixture.nativeSession.environment,
      });
      const { agent } = fixture.runtime;
      vi.mocked(agent.resolveAgentDir).mockReturnValue("/gateway/agents/main");
      vi.mocked(agent.resolveAgentWorkspaceDir).mockReturnValue("/gateway/workspace");
      const deleteSession = vi
        .spyOn(AgentsApiClient.prototype, "deleteSession")
        .mockResolvedValue();
      const cleanup = () =>
        operation === "reset"
          ? fixture.harness.reset({ ...fixture.params.sessionTarget, reason: "reset" })
          : fixture.harness.withSessionDeletion(fixture.target, async (settle) => settle());
      fixture.cancel.mockRejectedValueOnce(new Error("Native cancellation unavailable"));
      await expect(cleanup()).rejects.toThrow("Native cancellation unavailable");
      expect(await fixture.binding()).toEqual(saved);
      await cleanup();
      expect((await fixture.binding()) ?? {}).toEqual({});
      expect(resolveProviderAuth).toHaveBeenLastCalledWith(
        expect.objectContaining({
          provider: "openai",
          agentDir: "/gateway/agents/main",
          workspaceDir: "/gateway/workspace",
        }),
      );
      expect(agent.resolveAgentDir).toHaveBeenLastCalledWith(expect.any(Object), "main");
      expect(fixture.cancel).toHaveBeenCalledTimes(2);
      expect(deleteSession).not.toHaveBeenCalled();
    });
  });

  it.each([
    { outcome: "rollback", predecessor: false },
    { outcome: "reject", predecessor: true },
    { outcome: "commit", predecessor: true },
  ] as const)(
    "context reset: $outcome (predecessor: $predecessor)",
    async ({ outcome, predecessor }) => {
      await withNativeFixture(async (fixture) => {
        expect(await fixture.harness.runAttempt(fixture.params)).toMatchObject({
          terminal: { kind: "ok" },
        });
        const saved = await fixture.binding();
        const successor = {
          sessionId: "rotated-local-session",
          previousSessionId: fixture.params.sessionId,
        };
        if (predecessor) {
          await patchSessionEntry({
            ...fixture.params.sessionTarget,
            update: () => successor,
          });
        }
        fixture.events.length = 0;
        const failure = new Error("History cut rejected");
        const result = fixture.harness.withSessionContextReset(
          {
            ...fixture.target,
            ...(predecessor ? successor : {}),
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
        expect(await fixture.binding()).toEqual(outcome === "commit" ? undefined : saved);
        expect(fixture.events).toEqual(
          outcome === "commit" ? ["commit"] : outcome === "rollback" ? ["rollback"] : [],
        );
      });
    },
  );
}
