import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
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
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { captureActiveEmbeddedRunPersonalToolParticipants as captureParticipants } from "../embedded-agent-runner/run-state.js";
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
  admitted,
  expectOutcome,
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

function authority(profileId: string, retain?: AdmittedRunOperatorAuthority["retain"]) {
  return createAdmittedRunOperatorAuthority({
    profileId,
    retain,
    scopes: ["operator.read", "operator.write"],
    gatewayAccessGrant: null,
    modelPolicy: prepareOperatorModelPolicy({ cfg: {}, policy: {} }),
    assertCurrent() {},
  });
}

it("isolates overlapping participant sessions", async ({ onTestFinished }) => {
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
    await admitted(
      async ({ admittedRunContext }) => {
        const delegatedAuthority = expectDefined(
          getAdmittedRunDelegatedAuthority(admittedRunContext),
          "admitted participant turn",
        );
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
      },
      authority(profileId),
      { config, runId, boundary: "participants-test" },
    );
  };

  await withParticipants("alice", async (alice) => {
    const first = captureParticipants(alice.identity);
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
      return expectDefined(
        await resolveMessageActionAgentRuntimeIdentity({
          opts: {},
          target: "local",
          turnCapability: token,
          turnCapabilitySessionKey: policySessionKey,
          runId: alice.runId,
          sessionId,
        }),
        "admitted message-action identity",
      );
    };
    const messageIdentity = await resolveMessageIdentity(sessionKey);
    expect(messageIdentity.sessionKey).toBe(policySessionKey);
    const messageCapture = captureParticipants(messageIdentity);
    expect(messageCapture?.participants?.resolve()?.profileId).toBe("alice");
    const wrongExecutionIdentity = await resolveMessageIdentity("agent:main:another-run");
    expect(() => captureParticipants(wrongExecutionIdentity)).toThrow(
      "Personal-tool turn authority is no longer active",
    );
    await withParticipants("bob", async (bob) => {
      const second = captureParticipants(bob.identity);
      expect(second?.participants?.resolve()?.profileId).toBe("bob");
      expect(() => first?.assertCurrent()).not.toThrow();
      expect(isActiveEmbeddedRunId(alice.runId)).toBe(true);
      expect(isActiveEmbeddedRunId(bob.runId)).toBe(true);

      alice.retire();

      for (const capture of [first, messageCapture]) {
        expect(() => capture?.assertCurrent()).toThrow(
          "embedded reply authority is no longer active",
        );
      }
      expect(() => second?.assertCurrent()).not.toThrow();
      expect(isActiveEmbeddedRunId(alice.runId)).toBe(false);
      expect(isActiveEmbeddedRunId(bob.runId)).toBe(true);
      expect(captureParticipants(bob.identity)?.participants?.resolve()?.profileId).toBe("bob");
    });
  });
});

it("preserves requester ownership across reconnect and release", async () => {
  const retainOwner = vi.fn(() => vi.fn());
  const retainOtherRequester = vi.fn(() => vi.fn());
  const ownerAuthority = (profileId: string) =>
    authority(profileId, profileId === "alice" ? retainOwner : retainOtherRequester);
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
        operatorAuthority: ownerAuthority("bob"),
        senderId: "bob-sender",
        senderName: "Bob",
        clientCaps: ["ui-commands"],
        gatewayUiCommandTarget: { connId: "bob-tab", profileId: "bob" },
      };
      let pending: Awaited<ReturnType<typeof beginReplyMessageInjectionTarget>> | undefined;
      try {
        const target = captureCurrentReplyMessageInjectionTarget(sessionKey);
        expect(getSessionControllerOperation(sessionKey)).toBeDefined();
        const inject = (overlay: ReplyToolAuthorityOverlay) =>
          beginReplyMessageInjectionTarget(
            expectDefined(target, "injectable direct owner"),
            "Change my view",
            { isInboundUserMessage: true, toolAuthorityOverlay: overlay },
          );
        pending = await inject(incoming);
        await expect(pending.acceptance).resolves.toBe(false);
        await expectOutcome(pending.outcome, "rejected", "tool_authority_mismatch");
        expect(getGatewayToolCallerIdentity()?.personalToolParticipants?.resolve()?.profileId).toBe(
          "alice",
        );
        expect(retainOtherRequester).not.toHaveBeenCalled();
        expect(retainOwner.mock.results.length).toBeGreaterThan(0);
        for (const { value: release } of retainOwner.mock.results) {
          expect(release).not.toHaveBeenCalled();
        }
        pending = await inject({
          ...incoming,
          operatorAuthority: ownerAuthority("alice"),
          senderId: "alice-sender",
          senderName: "Alice renamed",
          gatewayUiCommandTarget: { connId: "alice-reconnected", profileId: "alice" },
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
        await expectOutcome(pending.outcome, "accepted");
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
    ownerAuthority("alice"),
  );
  expect(retainOtherRequester).not.toHaveBeenCalled();
  for (const { value: release } of retainOwner.mock.results) {
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
