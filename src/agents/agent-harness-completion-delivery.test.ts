import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureHarnessCompletionRecovery,
  createHarnessCompletionSourceAssertion,
  getOwedHarnessCompletionTask,
  readAdmittedHarnessCompletionInput,
} from "../agents/agent-harness-completion-recovery.js";
import { createAgentHarnessCompletionScope } from "../agents/agent-harness-completion-scope.js";
import {
  buildRestartRecoveryClaimCleanupPatch,
  getRestartRecoveryTerminalDeliveryEvidence,
} from "../config/sessions/restart-recovery-state.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadExactSessionEntry,
  readActiveTranscriptEntryAnchor,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { runWithSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { registerChatAbortController } from "../gateway/chat-abort.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { deliverAgentHarnessCompletion } from "../plugin-sdk/agent-harness-completion.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "./admitted-run-context.js";
import {
  buildCurrentRunRestartRecoveryClaim,
  buildRestartRecoveryTerminalDeliveryEvidence,
} from "./agent-command-restart-recovery.js";
import { reconcileHarnessCompletionDelivery } from "./agent-harness-completion-delivery.js";
import { captureAdmittedHarnessCompletionForTest } from "./agent-harness-completion.test-support.js";

const sessionKey = "agent:main:main";
const runId = "harness:child-1";
const announceId = "announce:example:parent:child-1:succeeded";
const deliveryContext = { channel: "discord", to: "channel:123", accountId: "main" };
const inputProvenance = {
  kind: "inter_session",
  sourceTool: "agent_harness_task",
  sourceChannel: "internal",
  sourceSessionKey: runId,
};

async function admit(
  state: OpenClawTestState,
  sourceDeliveryContext: { channel: string; to: string; accountId?: string } = deliveryContext,
) {
  const entry: SessionEntry = {
    sessionId: "physical-1",
    lifecycleRevision: "revision-1",
    updatedAt: Date.now(),
    status: "running",
  };
  const claim = await captureAdmittedHarnessCompletionForTest({
    agentId: "main",
    sessionKey,
    entry,
    runId: announceId,
    inputProvenance,
  });
  if (!claim) {
    throw new Error("real harness task did not bind at admission");
  }
  const admitted = {
    ...entry,
    ...buildCurrentRunRestartRecoveryClaim({
      entry,
      runId: announceId,
      sourceRunId: announceId,
      sourceIngress: "internal",
      sourceReplyDeliveryMode: "automatic",
      deliveryContext: sourceDeliveryContext,
      harnessCompletion: claim,
    }),
  };
  const target = {
    agentId: "main",
    sessionKey,
    storePath: path.join(state.sessionsDir(), "sessions.json"),
  };
  await replaceSessionEntry(target, admitted);
  return {
    entry: admitted,
    claim,
    target,
    request: { ...target, sourceRunId: announceId, taskRunId: runId },
  };
}

function terminalEntry(entry: SessionEntry, final = true): SessionEntry {
  return {
    ...entry,
    status: "done",
    ...buildRestartRecoveryClaimCleanupPatch({
      entry,
      recordTerminalSource: true,
      terminalRunId: "recovery-R",
      terminalDeliveryEvidence: buildRestartRecoveryTerminalDeliveryEvidence({
        messagingToolSentTargets: [
          {
            provider: "discord",
            accountId: "main",
            to: "channel:123",
            text: "reply",
            sourceReplyFinal: final,
          },
        ],
      }),
    }),
  };
}

describe("host-owned harness completion recovery", () => {
  it.each(["unchanged", "human", "reset", "queued-after-fence"])(
    "rechecks the admitted recovery input at %s",
    async (phase) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { claim, target, entry } = await admit(state);
        const transcript = { ...target, sessionId: entry.sessionId };
        await appendTranscriptMessage(transcript, {
          eventId: "completion-source",
          message: {
            role: "user",
            content: "completed child",
            idempotencyKey: `${announceId}:user`,
            __openclaw: { runId: announceId },
            provenance: inputProvenance,
          },
        });
        const recoveryRunId = "recovery-input-guard";
        await replaceSessionEntry(target, {
          ...entry,
          restartRecoveryDeliveryRunId: recoveryRunId,
        });
        const guard = createHarnessCompletionSourceAssertion({
          claim,
          storePath: target.storePath,
        });
        const admission = prepareAgentRunAdmission({
          cfg: {},
          facts: {
            agentId: "main",
            runId: recoveryRunId,
            ingress: { kind: "system", boundary: "test-harness-recovery", state: "present" },
          },
          operationalRunInstance: createOperationalRunInstanceRef(recoveryRunId),
          assertSourceCurrent: guard,
        });
        try {
          const context = await admission.admit("embedded");
          const effect = resolveAdmittedRunActiveAssertion(context);
          if (!effect) {
            throw new Error("Source effect was not captured.");
          }
          effect();
          if (phase === "reset") {
            await appendTranscriptEvent(transcript, {
              type: "reset",
              id: "source-reset",
              parentId: "completion-source",
              timestamp: "2026-09-14T00:00:00.000Z",
              reason: "new",
            });
          } else if (phase === "human" || phase === "queued-after-fence") {
            await appendTranscriptMessage(transcript, {
              eventId: "later-human",
              message: { role: "user", content: "new work", idempotencyKey: "later-human:user" },
            });
          }
          if (phase === "queued-after-fence") {
            const anchor = readActiveTranscriptEntryAnchor({
              ...transcript,
              entryId: "later-human",
            });
            if (!anchor) {
              throw new Error("Missing admission fence anchor.");
            }
            expect(() =>
              runWithSessionTranscriptReadFence(
                { ...anchor, logicalTurnId: recoveryRunId, role: "user" },
                effect,
              ),
            ).not.toThrow();
          } else if (phase === "unchanged") {
            expect(effect).not.toThrow();
          } else {
            expect(effect).toThrow();
          }
        } finally {
          admission.close();
        }
      });
    },
  );

  it.each(["before-admission", "after-admission"])(
    "revokes requester custody %s through the execution authority",
    async (phase) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { claim, target, entry } = await admit(state);
        const guard = createHarnessCompletionSourceAssertion({
          claim,
          storePath: target.storePath,
        });
        const admission = prepareAgentRunAdmission({
          cfg: {},
          facts: {
            agentId: "main",
            runId: announceId,
            ingress: { kind: "system", boundary: "test-harness-completion", state: "present" },
          },
          operationalRunInstance: createOperationalRunInstanceRef(announceId),
          assertSourceCurrent: guard,
        });
        try {
          if (phase === "before-admission") {
            await replaceSessionEntry(target, { ...entry, lifecycleRevision: "revoked-revision" });
            await expect(admission.admit("embedded")).rejects.toThrow();
          } else {
            const context = await admission.admit("embedded");
            const effect = resolveAdmittedRunActiveAssertion(context);
            expect(effect).toBeDefined();
            if (!effect) {
              throw new Error("Source effect was not captured.");
            }
            effect();
            await replaceSessionEntry(target, { ...entry, lifecycleRevision: "revoked-revision" });
            expect(effect).toThrow();
            expect(() => guard()).toThrow();
          }
        } finally {
          admission.close();
        }
      });
    },
  );

  it("reads a long turn's exact source and rejects an intervening user outside the recent tail", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { claim, entry, target } = await admit(state);
      const scope = { ...target, sessionId: entry.sessionId };
      await appendTranscriptMessage(scope, {
        message: {
          role: "user",
          content: "completed child",
          idempotencyKey: `${announceId}:user`,
          __openclaw: { runId: announceId },
          provenance: inputProvenance,
        },
      });
      for (let index = 0; index < 40; index++) {
        await appendTranscriptMessage(scope, {
          message: { role: "assistant", content: `tool work ${index}` },
        });
      }
      expect(
        readAdmittedHarnessCompletionInput({
          claim,
          entry,
          storePath: target.storePath,
          operationalRunId: announceId,
        }),
      ).toBe(true);
      await appendTranscriptMessage(scope, {
        message: { role: "user", content: "new human instruction" },
      });
      for (let index = 0; index < 40; index++) {
        await appendTranscriptMessage(scope, {
          message: { role: "assistant", content: `later work ${index}` },
        });
      }
      expect(
        readAdmittedHarnessCompletionInput({
          claim,
          entry,
          storePath: target.storePath,
          operationalRunId: announceId,
        }),
      ).toBe(false);
    });
  });

  it.each(["prior-generation", "intervening-human", "unknown-generation"])(
    "checks every admitted input after the completion: %s",
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { claim, entry, target } = await admit(state);
        const scope = { ...target, sessionId: entry.sessionId };
        await appendTranscriptMessage(scope, {
          message: {
            role: "user",
            content: "completed child",
            idempotencyKey: `${announceId}:user`,
            __openclaw: { runId: announceId },
            provenance: inputProvenance,
          },
        });
        if (scenario === "intervening-human") {
          await appendTranscriptMessage(scope, {
            message: { role: "user", content: "stop and do the newer work" },
          });
        }
        await appendTranscriptMessage(scope, {
          message: {
            role: "user",
            content: "resume",
            __openclaw: { runId: "recovery-R1" },
            provenance: {
              kind: "internal_system",
              sourceTool: "main_session_restart_recovery",
              sourceSessionKey: sessionKey,
            },
          },
        });
        const saved = {
          ...entry,
          restartRecoveryDeliveryRunId:
            scenario === "intervening-human" ? "recovery-R1" : "recovery-R2",
          restartRecoveryRuns:
            scenario === "unknown-generation"
              ? []
              : [{ runId: "recovery-R1", lifecycleGeneration: "dead-gateway" }],
        };
        await replaceSessionEntry(target, saved);
        expect(
          readAdmittedHarnessCompletionInput({
            claim,
            entry: saved,
            storePath: target.storePath,
            operationalRunId: saved.restartRecoveryDeliveryRunId,
          }),
        ).toBe(scenario === "prior-generation");
      });
    },
  );

  it.each(["physical", "revision"])(
    "rejects a contradictory historical requester %s before announcement",
    async (field) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { entry } = await admit(state);
        const delivery = await deliverAgentHarnessCompletion({
          scope: createAgentHarnessCompletionScope({ requesterSessionKey: sessionKey }),
          isSourceSessionAdmissionAllowed: () => true,
          childSessionKey: runId,
          childSessionId: "child-1",
          announceId: announceId.slice("announce:".length),
          status: "succeeded",
          result: "result",
          expectedRequester: {
            sessionId: field === "physical" ? "previous-physical" : entry.sessionId,
            lifecycleRevision: field === "revision" ? "previous-revision" : entry.lifecycleRevision,
          },
        });
        expect(delivery).toMatchObject({
          delivered: false,
          recoveryBlocked: true,
          error: "completion requester locator is missing or replaced",
        });
      });
    },
  );

  it.each(["active-source", "input-only"])(
    "does not replay %s after claim metadata is lost",
    async (retained) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { entry, target, request } = await admit(state);
        const lost = { ...entry, restartRecoveryHarnessCompletion: undefined };
        if (retained === "input-only") {
          lost.restartRecoveryDeliverySourceRunId = undefined;
          lost.restartRecoveryDeliveryRunId = undefined;
        }
        await replaceSessionEntry(target, lost);
        await appendTranscriptMessage(
          { ...target, sessionId: entry.sessionId },
          {
            message: {
              role: "user",
              content: "completed child",
              idempotencyKey: `${announceId}:user`,
              __openclaw: { runId: announceId },
              provenance: inputProvenance,
            },
          },
        );
        expect(reconcileHarnessCompletionDelivery(request)).toBe("blocked");
        const joined = await deliverAgentHarnessCompletion({
          scope: createAgentHarnessCompletionScope({ requesterSessionKey: sessionKey }),
          isSourceSessionAdmissionAllowed: () => true,
          childSessionKey: runId,
          childSessionId: "child-1",
          announceId: announceId.slice("announce:".length),
          status: "succeeded",
          result: "result",
        });
        expect(joined).toMatchObject({ delivered: false, recoveryBlocked: true });
      });
    },
  );

  it("keeps an accepted source pending and adopts its original identity in a new operational run", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { entry, claim, target, request } = await admit(state);
      await appendTranscriptMessage(
        { ...target, sessionId: entry.sessionId },
        {
          message: {
            role: "user",
            content: "completed child",
            idempotencyKey: `${announceId}:user`,
            __openclaw: { runId: announceId },
            provenance: inputProvenance,
          },
        },
      );

      expect(reconcileHarnessCompletionDelivery(request)).toBe("pending");
      const joined = await deliverAgentHarnessCompletion({
        scope: createAgentHarnessCompletionScope({ requesterSessionKey: sessionKey }),
        isSourceSessionAdmissionAllowed: () => true,
        childSessionKey: runId,
        childSessionId: "child-1",
        announceId: announceId.slice("announce:".length),
        status: "succeeded",
        result: "result",
      });
      expect(joined).toMatchObject({ delivered: false, recoveryPending: true });
      const reserved = {
        ...entry,
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "recovery-R",
      };
      const successor = {
        ...reserved,
        ...buildCurrentRunRestartRecoveryClaim({ entry: reserved, runId: "recovery-R" }),
      };
      await replaceSessionEntry(target, successor);
      expect(successor.restartRecoveryDeliverySourceRunId).toBe(announceId);
      expect(successor.restartRecoveryHarnessCompletion).toEqual(claim);
      expect(reconcileHarnessCompletionDelivery(request)).toBe("pending");
    });
  });

  it("settles a cold terminal receipt without a surviving native monitor or another announcement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { entry, target, request } = await admit(state);
      await replaceSessionEntry(target, terminalEntry(entry));
      expect(reconcileHarnessCompletionDelivery(request)).toBe("delivered");
    });
  });

  it.each([
    "exact",
    "default-account",
    "unresolved-default-explicit-account",
    "unresolved-default-foreign-account",
    "casefolded-provider",
    "missing-provider",
    "generic-provider",
    "missing-account",
    "wrong-account",
  ])("requires explicit durable message route evidence for %s", async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { entry, target, request } = await admit(
        state,
        kind === "default-account" || kind.startsWith("unresolved-default-")
          ? { channel: "discord", to: "channel:123" }
          : deliveryContext,
      );
      const terminal = terminalEntry(entry);
      const sent =
        terminal.restartRecoveryTerminalDeliveryEvidence?.[0]?.messagingToolSentTargets?.[0];
      if (!sent) {
        throw new Error("Missing real terminal target.");
      }
      if (kind === "casefolded-provider") {
        sent.provider = "DiScOrD";
      } else if (kind === "missing-provider") {
        delete sent.provider;
      } else if (kind === "generic-provider") {
        sent.provider = "message";
      } else if (kind === "missing-account" || kind === "default-account") {
        delete sent.accountId;
      } else if (kind === "wrong-account" || kind === "unresolved-default-foreign-account") {
        sent.accountId = "different-account";
      }
      await replaceSessionEntry(target, terminal);
      expect(reconcileHarnessCompletionDelivery(request)).toBe(
        ["exact", "default-account", "casefolded-provider"].includes(kind)
          ? "delivered"
          : "blocked",
      );
    });
  });

  it("does not promote an explicit progress receipt into a final after cold reading", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { entry, target, request } = await admit(state);
      await replaceSessionEntry(target, terminalEntry(entry, false));
      expect(reconcileHarnessCompletionDelivery(request)).toBe("blocked");
    });
  });

  it.each(["physical", "revision", "receipt-cleared"])(
    "does not settle a %s replacement from the old receipt",
    async (changed) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { entry, claim, target, request } = await admit(state);
        const terminal = terminalEntry(entry);
        if (changed === "physical") {
          terminal.sessionId = "physical-2";
        } else if (changed === "revision") {
          terminal.lifecycleRevision = "revision-2";
        } else {
          terminal.restartRecoveryTerminalDeliveryEvidence = [];
        }
        await replaceSessionEntry(target, terminal);
        expect(getOwedHarnessCompletionTask(claim, terminal)).toBeUndefined();
        expect(reconcileHarnessCompletionDelivery(request)).toBe("blocked");
      });
    },
  );

  it("requires the exact stored source and does not claim foreign or ordinary completions", async () => {
    for (const scenario of ["valid", "wrong-key", "ordinary-provenance"]) {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { claim, entry, target } = await admit(state);
        await appendTranscriptMessage(
          { ...target, sessionId: entry.sessionId },
          {
            message: {
              role: "user",
              content: "Background work finished",
              idempotencyKey: scenario === "wrong-key" ? "other:user" : `${announceId}:user`,
              __openclaw: { runId: announceId },
              provenance:
                scenario === "ordinary-provenance"
                  ? { ...inputProvenance, sourceTool: "subagent_announce" }
                  : inputProvenance,
            },
          },
        );
        expect(
          readAdmittedHarnessCompletionInput({ claim, entry, storePath: target.storePath }),
        ).toBe(scenario === "valid");
        expect(() =>
          captureHarnessCompletionRecovery({
            agentId: "other",
            sessionKey,
            entry,
            runId: announceId,
            inputProvenance,
          }),
        ).toThrow("host-issued source admission");
        expect(
          captureHarnessCompletionRecovery({
            agentId: "main",
            sessionKey,
            entry,
            runId: announceId,
            inputProvenance: { ...inputProvenance, sourceTool: "subagent_announce" },
          }),
        ).toBeUndefined();
      });
    }
  });

  it("does not settle a same-task receipt with a different requester generation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { entry, target, request } = await admit(state);
      await appendTranscriptMessage(
        { ...target, sessionId: entry.sessionId },
        {
          message: {
            role: "user",
            content: "completed child",
            idempotencyKey: `${announceId}:user`,
            __openclaw: { runId: announceId },
            provenance: inputProvenance,
          },
        },
      );

      const terminal = terminalEntry(entry);
      const receipt = terminal.restartRecoveryTerminalDeliveryEvidence?.[0];
      if (!receipt?.harnessCompletion) {
        throw new Error("missing terminal binding");
      }
      receipt.harnessCompletion.sessionId = "predecessor-physical";
      await replaceSessionEntry(target, {
        ...entry,
        restartRecoveryTerminalDeliveryEvidence: [receipt],
      });
      expect(reconcileHarnessCompletionDelivery(request)).toBe("pending");
    });
  });

  it("rejects stored zero-count, off-target, unmarked and truncated receipts before settling", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { entry, target, request } = await admit(state);
      const terminal = terminalEntry(entry);
      await replaceSessionEntry(target, terminal);
      const receipt = getRestartRecoveryTerminalDeliveryEvidence(
        loadExactSessionEntry(target)?.entry,
        announceId,
      );
      if (!receipt) {
        throw new Error("terminal receipt was not persisted");
      }
      const rejected = [
        { ...receipt, messagingToolSentTargetsTruncated: true as const },
        {
          ...receipt,
          messagingToolSentTargets: [
            { provider: "discord", to: "other", visible: true, sourceReplyFinal: true },
          ],
        },
        {
          ...receipt,
          messagingToolSentTargets: [{ provider: "discord", to: "channel:123", visible: true }],
        },
        {
          ...receipt,
          messagingToolSentTargets: [],
          payloads: [{ visible: true }],
          deliveryStatus: { status: "sent" as const, resultCount: 0 },
        },
      ];
      for (const evidence of rejected) {
        await replaceSessionEntry(target, {
          ...terminal,
          restartRecoveryTerminalDeliveryEvidence: [evidence],
        });
        expect(reconcileHarnessCompletionDelivery(request)).toBe("blocked");
      }
      await replaceSessionEntry(target, terminal);
      expect(reconcileHarnessCompletionDelivery(request)).toBe("delivered");
    });
  });
});

describe("review3 custody ownership", () => {
  it.each(["missing-source", "intervening-human", "valid-source"])(
    "retains task but releases non-executable %s custody",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { entry, target, request } = await admit(state);
        await replaceSessionEntry(target, { ...entry, abortedLastRun: true });
        if (kind !== "missing-source") {
          await appendTranscriptMessage(
            { ...target, sessionId: entry.sessionId },
            {
              message: {
                role: "user",
                content: "completed child",
                idempotencyKey: `${announceId}:user`,
                __openclaw: { runId: announceId },
                provenance: inputProvenance,
              },
            },
          );
        }
        if (kind === "intervening-human") {
          await appendTranscriptMessage(
            { ...target, sessionId: entry.sessionId },
            { message: { role: "user", content: "new human work" } },
          );
        }
        expect(reconcileHarnessCompletionDelivery(request)).toBe(
          kind === "valid-source" ? "pending" : "blocked",
        );
      });
    },
  );
  it.each(["owned", "ownerless", "foreign-physical", "released"])(
    "distinguishes an actual %s source before transcript commit",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { entry, request } = await admit(state);
        const context = {
          sessionKey,
          agentId: "main",
          sessionId: kind === "foreign-physical" ? "physical-2" : entry.sessionId,
        };
        let owner: string | undefined;
        try {
          if (kind === "ownerless") {
            registerAgentRunContext(announceId, context);
          } else {
            owner = claimAgentRunContext(announceId, context, {
              trackOwner: true,
              ownsContext: true,
            });
          }
          if (kind === "released") {
            releaseAgentRunContext(announceId, owner);
          }
          expect(reconcileHarnessCompletionDelivery(request)).toBe(
            kind === "owned" ? "pending" : "blocked",
          );
        } finally {
          if (owner) {
            releaseAgentRunContext(announceId, owner);
          } else {
            clearAgentRunContext(announceId);
          }
        }
      });
    },
  );
});

describe("review3 Gateway admission custody", () => {
  it.each([
    "held",
    "aborted",
    "foreign-physical",
    "released",
    "expired",
    "retired-generation",
    "closed-resolver",
    "throwing-resolver",
  ])("uses the real %s pre-execution registration", async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { entry, request } = await admit(state);
      const chatAbortControllers: GatewayRequestContext["chatAbortControllers"] = new Map();
      const registration = registerChatAbortController({
        chatAbortControllers,
        runId: announceId,
        sessionId: kind === "foreign-physical" ? "physical-2" : entry.sessionId,
        sessionKey,
        agentId: "main",
        timeoutMs: 60_000,
        kind: "agent",
        ...(kind === "retired-generation" ? { lifecycleGeneration: "old-gateway" } : {}),
        ...(kind === "expired" ? { expiresAtMs: Date.now() - 1 } : {}),
      });
      const context = { chatAbortControllers } as GatewayRequestContext;
      try {
        expect(registration.registered).toBe(true);
        expect(registration.entry?.executionStarted).toBe(false);
        if (kind === "aborted") {
          registration.controller.abort();
        }
        if (kind === "released") {
          registration.cleanup();
        }
        const result = withPluginRuntimeGatewayRequestScope(
          {
            context,
            resolveGatewayContext: () => {
              if (kind === "throwing-resolver") {
                throw new Error("Gateway instance unavailable for agent");
              }
              return kind === "closed-resolver" ? undefined : context;
            },
            isWebchatConnect: () => false,
          },
          () => reconcileHarnessCompletionDelivery(request),
        );
        expect(result).toBe(kind === "held" ? "pending" : "blocked");
      } finally {
        registration.cleanup();
      }
    });
  });
});
