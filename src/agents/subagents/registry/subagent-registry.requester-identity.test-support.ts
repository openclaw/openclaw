import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import * as config from "../../../config/config.js";
import { createAgentTurnTestContext } from "../../../gateway/agent-turn/agent-run-dispatch.test-support.js";
import {
  prepareAgentRunUserTurn,
  releasePreparedAgentRunUserTurn,
} from "../../../gateway/agent-turn/agent-run-user-turn.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { resolveGatewayOwnerOnlyToolDenylist } from "../../../security/dangerous-tools.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { resolveTurnToolSurface } from "../../agent-tools.turn-authority.js";
import type { AnyAgentTool } from "../../tools/common.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { retainedOperatorFixture } from "./subagent-registry.completed-followup-authority.test-support.js";
import { registerSubagentRun, replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import type { RegistryRegistrationFixture } from "./subagent-registry.requester-completion.fixture.test-support.js";

export function registerRequesterIdentityTests({
  registration,
  updateRun,
}: Pick<RegistryRegistrationFixture, "registration" | "updateRun">) {
  it("retains the exact channel requester across completion without borrowing a sibling", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { commands: { ownerAllowFrom: ["discord:original-owner"] } };
      config.setRuntimeConfigSnapshot(cfg);
      vi.mocked(config.getRuntimeConfig).mockReturnValue(cfg);
      const { context, client, source, revoked } = await retainedOperatorFixture(
        "channel-source",
        createContext([], () => cfg),
      );
      const origin = {
        sessionKey: "agent:main:main",
        messageProvider: "discord",
        accountId: "default",
        senderId: "original-owner",
        conversationId: "channel:fixture",
      };
      const register = (runId: string, senderId = origin.senderId, senderName = "Alice") =>
        withPluginRuntimeGatewayRequestScope(
          { client, context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
          () =>
            withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: origin.sessionKey,
                requesterOrigin: { ...origin, senderId, senderName },
                operatorAuthority: source.authority,
                gatewayContextResolver: () => context,
              },
              () =>
                registerSubagentRun(
                  registration(runId, {
                    requesterAgentId: "main",
                    requesterTurnRunId: "parent",
                  }),
                ),
            ),
        );
      try {
        await register("owner-child");
        await register("refresh-child");
        await register("renamed-child", origin.senderId, "Alice renamed");
        await register("foreign-child", "other-person");
        source.release();
        const entry = expectDefined(subagentRuns.get("owner-child"), "registered owner child");
        const foreign = expectDefined(
          subagentRuns.get("foreign-child"),
          "registered foreign child",
        );
        await subagentRuns.runWithCompletionBatchAuthority([entry], async (authority) => {
          expectDefined(authority, "retained source");
          await authority!.runWithRequester(async () => {
            expect(getGatewayToolCallerIdentity()?.requesterOrigin).toMatchObject(origin);
            expect(
              getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority?.source,
            ).toBe(source.authority.source);
          });
        });
        for (const [child, expectedOwner] of [
          [entry, true],
          [foreign, false],
        ] as const) {
          await subagentRuns.runWithCompletionAuthority(child, async (authority) => {
            await authority!.runWithRequester(async () => {
              const caller = expectDefined(getGatewayToolCallerIdentity(), "retained requester");
              const turn = await prepareAgentRunUserTurn({
                cfg,
                context: { ...createAgentTurnTestContext(), getRuntimeConfig: () => cfg },
                client: createSyntheticPluginRuntimeClient({
                  scopes: ["operator.admin"],
                  agentToolCaller: caller,
                  operatorRunAuthority: authority!.operatorAuthority,
                }),
                request: { message: "continue", idempotencyKey: "retained-owner-test" },
                runId: "retained-owner-test",
                admittedSessionId: "requester",
                resolvedSessionKey: origin.sessionKey,
                activeSessionAgentId: "main",
                suppressVisibleSessionEffects: true,
                requestedPromptPersistenceSuppression: true,
                canUseInternalRuntimeHandoff: false,
                message: "continue",
                effectiveTranscriptInputText: "continue",
                images: [],
                offloadedRefs: [],
                assertCurrent: authority!.assertCurrent,
                onUserTurnMediaPersisted: () => {},
              });
              try {
                expect(turn.senderIsOwner).toBe(expectedOwner);
                const effect = vi.fn(async () => ({
                  content: [{ type: "text" as const, text: "owner operation" }],
                  details: {},
                }));
                const tool: AnyAgentTool = {
                  name: "openclaw",
                  label: "OpenClaw",
                  description: "fixture",
                  parameters: {},
                  execute: effect,
                };
                const gate = resolveTurnToolSurface({
                  turnTools: [tool],
                  ownerOnlyDenied: new Set(resolveGatewayOwnerOnlyToolDenylist(turn.senderIsOwner)),
                });
                await gate.tools[0]!.execute("owner-operation", {});
                expect(effect).toHaveBeenCalledTimes(expectedOwner ? 1 : 0);
                effect.mockClear();
                const restricted = resolveTurnToolSurface({
                  turnTools: [],
                  sessionTools: [tool],
                  ownerOnlyDenied: new Set(),
                });
                await restricted.tools[0]!.execute("source-denied-operation", {});
                expect(effect).not.toHaveBeenCalled();
              } finally {
                await releasePreparedAgentRunUserTurn(turn);
              }
            });
          });
        }
        await subagentRuns.runWithCompletionBatchAuthority(
          [entry, expectDefined(subagentRuns.get("renamed-child"), "renamed child")],
          async (authority) => {
            await expectDefined(authority, "same principal authority").runWithRequester(
              async () => {
                expect(getGatewayToolCallerIdentity()?.requesterOrigin?.senderId).toBe(
                  origin.senderId,
                );
              },
            );
          },
        );
        expect(
          subagentRuns.runWithCompletionBatchAuthority([entry, foreign], (authority) => {
            expect(authority).toBeUndefined();
            expect(getGatewayToolCallerIdentity()).toBeUndefined();
            expect(
              getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority?.source,
            ).toBe(source.authority.source);
            return "both results can be delivered without borrowing a human";
          }),
        ).toBe("both results can be delivered without borrowing a human");
        await withPluginRuntimeGatewayRequestScope(
          { client, context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
          () =>
            withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: origin.sessionKey,
                requesterOrigin: origin,
                operatorAuthority: source.authority,
                gatewayContextResolver: () => context,
              },
              async () => {
                expect(
                  await replaceSubagentRunAfterSteerCore({
                    previousRunId: "refresh-child",
                    nextRunId: "refreshed-child",
                    refreshCompletionAuthority: true,
                  }),
                ).toBe(true);
              },
            ),
        );
        await subagentRuns.runWithCompletionAuthority(
          expectDefined(subagentRuns.get("refreshed-child"), "refreshed child"),
          async (authority) => {
            await authority!.runWithRequester(async () =>
              expect(getGatewayToolCallerIdentity()?.requesterOrigin).toMatchObject(origin),
            );
          },
        );
        await updateRun(foreign.runId, (draft) => {
          draft.endedReason = "subagent-killed";
          draft.execution = { status: "terminal", endedAt: 1, outcome: { status: "error" } };
        });
        subagentRuns.runWithCompletionBatchAuthority([entry, foreign], (authority) => {
          expect(authority).toBeUndefined();
          expect(getGatewayToolCallerIdentity()).toBeUndefined();
        });
        await updateRun(entry.runId, (draft) => {
          draft.endedReason = "subagent-killed";
          draft.execution = { status: "terminal", endedAt: 1, outcome: { status: "error" } };
        });
        subagentRuns.runWithCompletionBatchAuthority([entry, foreign], (authority) => {
          expect(authority).toBeUndefined();
          expect(getGatewayToolCallerIdentity()).toBeUndefined();
        });
        revoked.abort(new Error("original requester revoked"));
        expect(() =>
          subagentRuns.runWithCompletionAuthority(
            expectDefined(subagentRuns.get("refreshed-child"), "live refreshed child"),
            () => "stale",
          ),
        ).toThrow();
      } finally {
        source.release();
      }
    });
  });
}
