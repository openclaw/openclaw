import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createPersonalToolScreenDispatcher } from "../../auto-reply/reply/personal-tool-turn.test-support.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
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
import { createEmbeddedRunHandle, testing } from "../embedded-agent-runner/runs.test-support.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { resolveMessageActionAgentRuntimeIdentity } from "../tools/gateway.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";
import {
  attempt,
  interceptMessages,
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
  it("keeps execution ownership across message policy sessions and overlapping session IDs", async ({
    onTestFinished,
  }) => {
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
      const policySessionKey = "agent:main:telegram:proof:direct:2468";
      const resolveMessageIdentity = async (sourceReplySessionKey: string) => {
        const token = mintMessageActionTurnCapability({
          agentId: "main",
          runId: alice.runId,
          sessionKey: policySessionKey,
          sourceReplySessionKey,
          sessionId,
        });
        onTestFinished(() => {
          expect(revokeMessageActionTurnCapability(token)).toBe(true);
        });
        const identity = await resolveMessageActionAgentRuntimeIdentity({
          opts: {},
          target: "local",
          turnCapability: token,
          turnCapabilitySessionKey: policySessionKey,
          runId: alice.runId,
          sessionId,
        });
        if (!identity) {
          throw new Error("Expected an admitted message-action identity");
        }
        return identity;
      };
      const messageIdentity = await resolveMessageIdentity(sessionKey);
      expect(messageIdentity.sessionKey).toBe(policySessionKey);
      const messageCapture = captureActiveEmbeddedRunPersonalToolParticipants(messageIdentity);
      expect(messageCapture?.participants?.resolve()?.profileId).toBe("alice");
      const wrongExecutionIdentity = await resolveMessageIdentity("agent:main:another-run");
      expect(() =>
        captureActiveEmbeddedRunPersonalToolParticipants(wrongExecutionIdentity),
      ).toThrow("Personal-tool turn authority is no longer active");
      await withParticipants("bob", async (bob) => {
        const second = captureActiveEmbeddedRunPersonalToolParticipants(bob.identity);
        expect(second?.participants?.resolve()?.profileId).toBe("bob");
        expect(() => first?.assertCurrent()).not.toThrow();
        expect(isActiveEmbeddedRunId(alice.runId)).toBe(true);
        expect(isActiveEmbeddedRunId(bob.runId)).toBe(true);

        alice.retire();

        expect(() => first?.assertCurrent()).toThrow(
          "embedded reply authority is no longer active",
        );
        expect(() => messageCapture?.assertCurrent()).toThrow(
          "embedded reply authority is no longer active",
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

  it("refuses another person while preserving same-requester reconnect and participant lifetime", async () => {
    const modelPolicy = prepareOperatorModelPolicy({ cfg: {}, policy: {} });
    const ownerReleases: ReturnType<typeof vi.fn>[] = [];
    const retainOwner = vi.fn(() => {
      const release = vi.fn();
      ownerReleases.push(release);
      return release;
    });
    const retainOtherRequester = vi.fn(() => vi.fn());
    const authority = (profileId: string) =>
      createAdmittedRunOperatorAuthority({
        profileId,
        scopes: ["operator.read", "operator.write"],
        gatewayAccessGrant: null,
        modelPolicy,
        assertCurrent() {},
        retain: profileId === "alice" ? retainOwner : retainOtherRequester,
      });
    const dispatch = await createPersonalToolScreenDispatcher(["alice", "bob"]);
    const retained = await published(
      async ({ handle }) => {
        const releaseQueue = createDeferred();
        let queueReturned = false;
        handle.supportsTranscriptCommitWait = true;
        interceptMessages(handle, async (_text, options) => {
          options?.onQueueAccepted?.(true);
          await releaseQueue.promise;
          queueReturned = true;
        });
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
          const target = captureCurrentReplyMessageInjectionTarget(sessionKey);
          expect(getSessionControllerOperation(sessionKey)).toBeDefined();
          if (!target) {
            throw new Error("Expected the direct admitted owner to be injectable");
          }
          pending = await beginReplyMessageInjectionTarget(target, "Change my view", {
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
          expect(retainOtherRequester).not.toHaveBeenCalled();
          expect(ownerReleases.length).toBeGreaterThan(0);
          for (const release of ownerReleases) {
            expect(release).not.toHaveBeenCalled();
          }
          pending = await beginReplyMessageInjectionTarget(target, "Change my view", {
            isInboundUserMessage: true,
            toolAuthorityOverlay: {
              ...incoming,
              operatorAuthority: authority("alice"),
              senderId: "alice-sender",
              senderName: "Alice renamed",
              gatewayUiCommandTarget: { connId: "alice-reconnected", profileId: "alice" },
            },
          });
          await expect(pending.acceptance).resolves.toBe(true);
          const selected = await dispatch();
          expect(selected.respond).toHaveBeenCalledWith(true, { ok: true });
          expect(selected.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
            "ui.command",
            { command: { kind: "sidebar", visible: false } },
            new Set(["alice-tab"]),
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
    );
    expect(retainOtherRequester).not.toHaveBeenCalled();
    for (const release of ownerReleases) {
      expect(release).toHaveBeenCalledOnce();
    }
    const closed = await withGatewayToolCallerIdentity(retained, () => dispatch("alice"));
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
