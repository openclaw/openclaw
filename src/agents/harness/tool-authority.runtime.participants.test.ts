import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createPersonalToolScreenDispatcher } from "../../auto-reply/reply/personal-tool-turn.test-support.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import type { ReplyToolAuthorityOverlay } from "../../sessions/session-controller.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  getSessionControllerOperation,
} from "../../sessions/session-controller.js";
import { captureCurrentReplyMessageInjectionTarget } from "../../sessions/session-controller.message-injection.js";
import { testing as replyTesting } from "../../sessions/session-controller.test-support.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { captureActiveEmbeddedRunPersonalToolParticipants } from "../embedded-agent-runner/run-state.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
  isActiveEmbeddedRunId,
} from "../embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  testing,
} from "../embedded-agent-runner/runs.test-support.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";
import {
  attempt,
  published,
  sessionId,
  sessionKey,
} from "./tool-authority.runtime.test-support.js";

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetSessionControllerForTest();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

describe("host-prepared embedded tool authority", () => {
  it("keeps personal-tool captures scoped to their controller when session IDs overlap", async () => {
    const modelPolicy = prepareOperatorModelPolicy({ cfg: {}, policy: {} });
    const withParticipants = async (
      profileId: string,
      run: (turn: {
        identity: AgentRuntimeIdentity;
        runId: string;
        retire: () => void;
      }) => Promise<void>,
    ) => {
      const runId = `participants-${profileId}`;
      const sessionFile = `/synthetic/participants/${profileId}/session.jsonl`;
      const config = { session: { store: `/synthetic/participants/${profileId}/sessions.json` } };
      const operatorAuthority = createAdmittedRunOperatorAuthority({
        profileId,
        scopes: ["operator.read", "operator.write"],
        gatewayAccessGrant: null,
        modelPolicy,
        assertCurrent() {},
      });
      const admission = prepareAgentRunAdmission({
        cfg: config,
        operatorAuthority,
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        facts: {
          agentId: "main",
          runId,
          ingress: { kind: "system", state: "present", boundary: "participants-test" },
        },
      });
      try {
        const admittedRunContext = await admission.admit("embedded", "participants-test");
        const delegatedAuthority = getAdmittedRunDelegatedAuthority(admittedRunContext);
        if (!delegatedAuthority) {
          throw new Error("Expected an admitted participant turn");
        }
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext },
          { ...attempt, config, runId, sessionFile },
          undefined,
          async (prepared) => {
            const handle = createEmbeddedRunHandle({
              runId,
              toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
            });
            attachActiveEmbeddedRun(
              sessionId,
              handle,
              sessionKey,
              sessionFile,
              "main",
              prepared.replyOperation,
            );
            const retire = () => detachActiveEmbeddedRun(sessionId, handle, sessionKey);
            try {
              await run({
                identity: {
                  kind: "agentRuntime",
                  agentId: "main",
                  sessionKey,
                  operationalRunInstance: admittedRunContext.operationalRunInstance,
                  delegatedAuthority: { ...delegatedAuthority, kind: "local" },
                },
                runId,
                retire,
              });
            } finally {
              retire();
            }
          },
        );
      } finally {
        admission.close();
      }
    };

    await withParticipants("alice", async (alice) => {
      const first = captureActiveEmbeddedRunPersonalToolParticipants(alice.identity);
      expect(first?.participants?.resolve()?.profileId).toBe("alice");
      await withParticipants("bob", async (bob) => {
        const second = captureActiveEmbeddedRunPersonalToolParticipants(bob.identity);
        expect(second?.participants?.resolve()?.profileId).toBe("bob");
        expect(() => first?.assertCurrent()).not.toThrow();
        expect(isActiveEmbeddedRunId(alice.runId)).toBe(true);
        expect(isActiveEmbeddedRunId(bob.runId)).toBe(true);

        alice.retire();

        expect(() => first?.assertCurrent()).toThrow(
          "Personal-tool turn authority is no longer active",
        );
        expect(() => second?.assertCurrent()).not.toThrow();
        expect(isActiveEmbeddedRunId(alice.runId)).toBe(false);
        expect(isActiveEmbeddedRunId(bob.runId)).toBe(true);
        expect(
          captureActiveEmbeddedRunPersonalToolParticipants(bob.identity)?.participants?.resolve()
            ?.profileId,
        ).toBe("bob");
      });
    });
  });

  it("binds accepted direct-turn participants before queue settlement and releases them at close", async () => {
    const modelPolicy = prepareOperatorModelPolicy({ cfg: {}, policy: {} });
    const releaseSteerer = vi.fn();
    const retainSteerer = vi.fn(() => releaseSteerer);
    const authority = (profileId: string) =>
      createAdmittedRunOperatorAuthority({
        profileId,
        scopes: ["operator.read", "operator.write"],
        gatewayAccessGrant: null,
        modelPolicy,
        assertCurrent() {},
        ...(profileId === "bob" ? { retain: retainSteerer } : {}),
      });
    const dispatch = await createPersonalToolScreenDispatcher(["alice", "bob"]);
    const releaseQueue = createDeferred();
    let queueReturned = false;
    const retained = await published(
      async ({ handle }) => {
        const incoming: ReplyToolAuthorityOverlay = {
          senderIsOwner: true,
          disableTools: false,
          traceAuthorized: false,
          messageProvider: "webchat",
          operatorAuthority: authority("bob"),
          senderId: "bob-sender",
          senderName: "Bob",
          clientCaps: ["ui-commands"],
          gatewayUiCommandTarget: { connId: "bob-tab", profileId: "bob" },
        };
        let pending: Awaited<ReturnType<typeof beginReplyMessageInjectionTarget>> | undefined;
        try {
          const restricted = { ...handle, supportsCrossProfileSteering: false };
          setActiveEmbeddedRun(sessionId, restricted, sessionKey, attempt.sessionFile);
          const restrictedTarget = captureCurrentReplyMessageInjectionTarget(sessionKey)!;
          pending = await beginReplyMessageInjectionTarget(restrictedTarget, "Change my view", {
            isInboundUserMessage: true,
            toolAuthorityOverlay: incoming,
          });
          await expect(pending.acceptance).resolves.toBe(false);
          await expect(pending.outcome).resolves.toMatchObject({
            status: "rejected",
            reason: "tool_authority_mismatch",
          });
          expect(
            getGatewayToolCallerIdentity()?.personalToolParticipants?.resolve()?.profileId,
          ).toBe("alice");
          expect(retainSteerer).not.toHaveBeenCalled();
          setActiveEmbeddedRun(sessionId, handle, sessionKey, attempt.sessionFile);
          const target = captureCurrentReplyMessageInjectionTarget(sessionKey);
          expect(getSessionControllerOperation(sessionKey)).toBeDefined();
          if (!target) {
            throw new Error("Expected the direct admitted owner to be injectable");
          }
          pending = await beginReplyMessageInjectionTarget(target, "Change my view", {
            isInboundUserMessage: true,
            toolAuthorityOverlay: incoming,
          });
          await expect(pending.acceptance).resolves.toBe(true);
          const ambiguous = await dispatch();
          expect(ambiguous.respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              code: "INVALID_REQUEST",
              message: expect.stringMatching(/Alice \(user: alice\)[\s\S]*Bob \(user: bob\)/),
            }),
          );
          expect(ambiguous.broadcastToConnIds).not.toHaveBeenCalled();
          const selected = await dispatch("bob");
          expect(selected.respond).toHaveBeenCalledWith(true, { ok: true });
          expect(selected.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
            "ui.command",
            { command: { kind: "sidebar", visible: false } },
            new Set(["bob-tab"]),
          );
          expect(queueReturned).toBe(false);
          releaseQueue.resolve();
          await expect(pending.outcome).resolves.toMatchObject({ status: "accepted" });
        } finally {
          releaseQueue.resolve();
          await pending?.outcome;
        }
        return getGatewayToolCallerIdentity();
      },
      {
        senderId: "alice-sender",
        senderName: "Alice",
        clientCaps: ["ui-commands"],
        gatewayUiCommandTarget: { connId: "alice-tab", profileId: "alice" },
      },
      authority("alice"),
      (handle) => {
        handle.supportsTranscriptCommitWait = true;
        handle.messageInjectionV2 = {
          version: 2,
          isAvailable: () => true,
          queueMessage: async (_text, options, assertCurrent) => {
            assertCurrent();
            options?.onQueueAccepted?.(true);
            await releaseQueue.promise;
            queueReturned = true;
          },
        };
      },
    );
    expect(retainSteerer).toHaveBeenCalledOnce();
    expect(releaseSteerer).toHaveBeenCalledOnce();
    const closed = await withGatewayToolCallerIdentity(retained, () => dispatch("bob"));
    expect(closed.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("turn has ended"),
      }),
    );
    expect(closed.broadcastToConnIds).not.toHaveBeenCalled();
  });
});
