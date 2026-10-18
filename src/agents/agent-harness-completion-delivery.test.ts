import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  captureHarnessCompletionRecovery,
  createHarnessCompletionSourceAssertion,
  getOwedHarnessCompletionTask,
  readAdmittedHarnessCompletionInputAsync,
} from "../agents/agent-harness-completion-recovery.js";
import { createAgentHarnessCompletionScope } from "../agents/agent-harness-completion-scope.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  buildRestartRecoveryClaimCleanupPatch,
  getRestartRecoveryTerminalDeliveryEvidence,
} from "../config/sessions/restart-recovery-state.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
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
import { runWithAgentToolSourceExecutionScope } from "./agent-tool-source-execution-guard.js";

afterEach(() => clearRuntimeConfigSnapshot());

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
  setRuntimeConfigSnapshot({});
  const entry: SessionEntry = {
    sessionId: "physical-1",
    lifecycleRevision: "revision-1",
    updatedAt: Date.now(),
  };
  const source = {
    agentId: "main",
    sessionKey,
    entry,
    runId: announceId,
    inputProvenance,
  };
  const claim = await captureAdmittedHarnessCompletionForTest(source);
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
    source,
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

type AdmittedCompletion = Awaited<ReturnType<typeof admit>>;

function withCompletion(run: (completion: AdmittedCompletion) => Promise<void>) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => run(await admit(state)));
}

function deliver(
  expectedRequester?: Parameters<typeof deliverAgentHarnessCompletion>[0]["expectedRequester"],
) {
  return deliverAgentHarnessCompletion({
    scope: createAgentHarnessCompletionScope({ requesterSessionKey: sessionKey }),
    isSourceSessionAdmissionAllowed: () => true,
    childSessionKey: runId,
    childSessionId: "child-1",
    announceId: announceId.slice("announce:".length),
    status: "succeeded",
    result: "result",
    expectedRequester,
  });
}

function readInput(
  { claim, entry, target }: Pick<AdmittedCompletion, "claim" | "entry" | "target">,
  operationalRunId?: string,
) {
  return readAdmittedHarnessCompletionInputAsync({
    claim,
    entry,
    storePath: target.storePath,
    operationalRunId,
  });
}

function appendCompletionSource({ target, entry }: Pick<AdmittedCompletion, "target" | "entry">) {
  return appendTranscriptMessage(
    { ...target, sessionId: entry.sessionId },
    {
      eventId: "completion-source",
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

function prepareCompletionAdmission(
  { claim, target }: Pick<AdmittedCompletion, "claim" | "target">,
  operationalRunId = announceId,
) {
  return prepareAgentRunAdmission({
    cfg: {},
    facts: {
      agentId: "main",
      runId: operationalRunId,
      ingress: { kind: "system", boundary: "test-harness-completion", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(operationalRunId),
    assertSourceCurrent: createHarnessCompletionSourceAssertion({
      claim,
      storePath: target.storePath,
    }),
  });
}

async function admitEffect(admission: ReturnType<typeof prepareCompletionAdmission>) {
  const assertion = resolveAdmittedRunActiveAssertion(await admission.admit("embedded"));
  if (!assertion) {
    throw new Error("Source effect was not captured.");
  }
  return {
    assertion,
    effect: () => runWithAgentToolSourceExecutionScope(assertion, async () => assertion()),
  };
}

describe("host-owned harness completion recovery", () => {
  it.each(["human", "reset", "queued-after-fence"])(
    "rechecks the admitted recovery input at %s",
    (phase) =>
      withCompletion(async ({ claim, target, entry }) => {
        const transcript = { ...target, sessionId: entry.sessionId };
        await appendCompletionSource({ target, entry });
        const recoveryRunId = "recovery-input-guard";
        await replaceSessionEntry(target, {
          ...entry,
          restartRecoveryDeliveryRunId: recoveryRunId,
        });
        const admission = prepareCompletionAdmission({ claim, target }, recoveryRunId);
        try {
          const { effect } = await admitEffect(admission);
          await effect();
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
            await expect(
              runWithSessionTranscriptReadFence(
                { ...anchor, logicalTurnId: recoveryRunId, role: "user" },
                effect,
              ),
            ).resolves.toBeUndefined();
          } else {
            await expect(effect()).rejects.toThrow();
          }
        } finally {
          admission.close();
        }
      }),
  );

  it.each(["before-admission", "after-admission", "at-effect"])(
    "revokes requester custody %s through the execution authority",
    (phase) =>
      withCompletion(async ({ claim, target, entry }) => {
        const admission = prepareCompletionAdmission({ claim, target });
        try {
          if (phase === "before-admission") {
            await replaceSessionEntry(target, { ...entry, lifecycleRevision: "revoked-revision" });
            await expect(admission.admit("embedded")).rejects.toThrow();
          } else {
            const { assertion, effect } = await admitEffect(admission);
            expect(assertion).toBeDefined();
            await effect();
            const revoke = () =>
              replaceSessionEntry(target, { ...entry, lifecycleRevision: "revoked-revision" });
            if (phase === "at-effect") {
              await expect(
                runWithAgentToolSourceExecutionScope(assertion, async () => {
                  await revoke();
                  assertion();
                }),
              ).rejects.toThrow();
            } else {
              await revoke();
              await expect(effect()).rejects.toThrow();
            }
          }
        } finally {
          admission.close();
        }
      }),
  );

  it("reads a long turn's exact source and rejects an intervening user outside the recent tail", () =>
    withCompletion(async ({ claim, entry, target }) => {
      const scope = { ...target, sessionId: entry.sessionId };
      await appendCompletionSource({ target, entry });
      for (let index = 0; index < 40; index++) {
        await appendTranscriptMessage(scope, {
          message: { role: "assistant", content: `tool work ${index}` },
        });
      }
      expect(await readInput({ claim, entry, target }, announceId)).toBe(true);
      await appendTranscriptMessage(scope, {
        message: { role: "user", content: "new human instruction" },
      });
      for (let index = 0; index < 40; index++) {
        await appendTranscriptMessage(scope, {
          message: { role: "assistant", content: `later work ${index}` },
        });
      }
      expect(await readInput({ claim, entry, target }, announceId)).toBe(false);
    }));

  it.each(["prior-generation", "intervening-human", "unknown-generation"])(
    "checks every admitted input after the completion: %s",
    (scenario) =>
      withCompletion(async ({ claim, entry, target }) => {
        const scope = { ...target, sessionId: entry.sessionId };
        await appendCompletionSource({ target, entry });
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
          await readInput({ claim, entry: saved, target }, saved.restartRecoveryDeliveryRunId),
        ).toBe(scenario === "prior-generation");
      }),
  );

  it.each(["physical", "revision"])(
    "rejects a contradictory historical requester %s before announcement",
    (field) =>
      withCompletion(async ({ entry }) => {
        const delivery = await deliver({
          sessionId: field === "physical" ? "previous-physical" : entry.sessionId,
          lifecycleRevision: field === "revision" ? "previous-revision" : entry.lifecycleRevision,
        });
        expect(delivery).toMatchObject({
          delivered: false,
          recoveryBlocked: true,
          error: "completion requester locator is missing or replaced",
        });
      }),
  );

  it.each(["active-source", "input-only"])(
    "does not replay %s after claim metadata is lost",
    (retained) =>
      withCompletion(async ({ entry, target, request }) => {
        const lost = { ...entry, restartRecoveryHarnessCompletion: undefined };
        if (retained === "input-only") {
          lost.restartRecoveryDeliverySourceRunId = undefined;
          lost.restartRecoveryDeliveryRunId = undefined;
        }
        await replaceSessionEntry(target, lost);
        await appendCompletionSource({ target, entry });
        expect(await reconcileHarnessCompletionDelivery(request)).toBe("blocked");
        const submittedRead = sessionAccessor.readSessionSubmittedInput;
        const queries: string[] = [];
        using read = vi
          .spyOn(sessionAccessor, "readSessionSubmittedInput")
          .mockImplementation(async (...args) => {
            // Measure the moved read; existing requester and authority reads stay outside this boundary.
            const sql = observeHostDataSql();
            try {
              return await submittedRead(...args);
            } finally {
              queries.push(...sql.queries);
              sql.restore();
            }
          });
        const joined = await deliver();
        expect(joined).toMatchObject({ delivered: false, recoveryBlocked: true });
        expect(read).toHaveBeenCalledTimes(retained === "input-only" ? 1 : 0);
        expect(queries).toEqual([]);
      }),
  );

  it("leaves completion without a saved claim or submitted input unowned", () =>
    withCompletion(async ({ entry, target, request }) => {
      await replaceSessionEntry(target, {
        ...entry,
        restartRecoveryHarnessCompletion: undefined,
        restartRecoveryDeliverySourceRunId: undefined,
        restartRecoveryDeliveryRunId: undefined,
      });
      expect(await reconcileHarnessCompletionDelivery(request)).toBe("unowned");
    }));

  it("keeps an accepted source pending and adopts its original identity in a new operational run", () =>
    withCompletion(async ({ entry, claim, target, request }) => {
      await appendCompletionSource({ target, entry });

      expect(await reconcileHarnessCompletionDelivery(request)).toBe("pending");
      const joined = await deliver();
      expect(joined).toMatchObject({ delivered: false, recoveryPending: true });
      const reserved = {
        ...entry,
        status: "interrupted" as const,
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
      expect(await reconcileHarnessCompletionDelivery(request)).toBe("pending");
    }));

  it.each([
    ["cold-final", "delivered"],
    ["progress", "blocked"],
    ["default-account", "delivered"],
    ["unresolved-default-explicit-account", "blocked"],
    ["casefolded-provider", "delivered"],
    ["missing-provider", "blocked"],
    ["generic-provider", "blocked"],
    ["missing-account", "blocked"],
    ["wrong-account", "blocked"],
    ["physical", "blocked"],
    ["revision", "blocked"],
    ["receipt-cleared", "blocked"],
  ] as const)("settles only current, final, exact-route durable receipts: %s", (kind, expected) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { entry, claim, target, request } = await admit(
        state,
        kind === "default-account" || kind === "unresolved-default-explicit-account"
          ? { channel: "discord", to: "channel:123" }
          : deliveryContext,
      );
      const terminal = terminalEntry(entry, kind !== "progress");
      const sent =
        terminal.restartRecoveryTerminalDeliveryEvidence?.[0]?.messagingToolSentTargets?.[0];
      if (!sent) {
        throw new Error("Missing real terminal target.");
      }
      switch (kind) {
        case "cold-final":
        case "progress":
        case "unresolved-default-explicit-account":
          break;
        case "casefolded-provider":
          sent.provider = "DiScOrD";
          break;
        case "missing-provider":
          delete sent.provider;
          break;
        case "generic-provider":
          sent.provider = "message";
          break;
        case "default-account":
        case "missing-account":
          delete sent.accountId;
          break;
        case "wrong-account":
          sent.accountId = "different-account";
          break;
        case "physical":
          terminal.sessionId = "physical-2";
          break;
        case "revision":
          terminal.lifecycleRevision = "revision-2";
          break;
        case "receipt-cleared":
          terminal.restartRecoveryTerminalDeliveryEvidence = [];
          break;
      }
      await replaceSessionEntry(target, terminal);
      if (kind === "physical" || kind === "revision" || kind === "receipt-cleared") {
        expect(getOwedHarnessCompletionTask(claim, terminal)).toBeUndefined();
      }
      expect(await reconcileHarnessCompletionDelivery(request)).toBe(expected);
    }),
  );

  it("requires the exact stored source and does not claim foreign or ordinary completions", async () => {
    for (const scenario of ["valid", "wrong-key", "ordinary-provenance"]) {
      await withCompletion(async ({ claim, entry, target, source }) => {
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
        expect(await readInput({ claim, entry, target })).toBe(scenario === "valid");
        expect(() => captureHarnessCompletionRecovery({ ...source, agentId: "other" })).toThrow(
          "host-issued source admission",
        );
        expect(
          captureHarnessCompletionRecovery({
            ...source,
            inputProvenance: { ...inputProvenance, sourceTool: "subagent_announce" },
          }),
        ).toBeUndefined();
      });
    }
  });

  it("does not settle a same-task receipt with a different requester generation", () =>
    withCompletion(async ({ entry, target, request }) => {
      await appendCompletionSource({ target, entry });

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
      expect(await reconcileHarnessCompletionDelivery(request)).toBe("pending");
    }));

  it("rejects stored zero-count, off-target, unmarked and truncated receipts before settling", () =>
    withCompletion(async ({ entry, target, request }) => {
      const terminal = terminalEntry(entry);
      await replaceSessionEntry(target, terminal);
      const receipt = getRestartRecoveryTerminalDeliveryEvidence(
        loadExactSessionEntry(target)?.entry,
        announceId,
      );
      if (!receipt) {
        throw new Error("terminal receipt was not persisted");
      }
      const visibleTarget = {
        provider: "discord",
        accountId: "main",
        to: "channel:123",
        visible: true,
      };
      const rejected = [
        { ...receipt, messagingToolSentTargetsTruncated: true as const },
        {
          ...receipt,
          messagingToolSentTargets: [{ ...visibleTarget, to: "other", sourceReplyFinal: true }],
        },
        {
          ...receipt,
          messagingToolSentTargets: [visibleTarget],
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
        expect(await reconcileHarnessCompletionDelivery(request)).toBe("blocked");
      }
      await replaceSessionEntry(target, terminal);
      expect(await reconcileHarnessCompletionDelivery(request)).toBe("delivered");
    }));
});

describe("review3 custody ownership", () => {
  it.each(["missing-source", "intervening-human"])(
    "retains task but releases non-executable %s custody",
    (kind) =>
      withCompletion(async ({ entry, target, request }) => {
        await replaceSessionEntry(target, {
          ...entry,
          status: "interrupted",
          abortedLastRun: true,
        });
        if (kind !== "missing-source") {
          await appendCompletionSource({ target, entry });
        }
        if (kind === "intervening-human") {
          await appendTranscriptMessage(
            { ...target, sessionId: entry.sessionId },
            { message: { role: "user", content: "new human work" } },
          );
        }
        expect(await reconcileHarnessCompletionDelivery(request)).toBe("blocked");
      }),
  );
  it.each(["owned", "ownerless", "foreign-physical", "released"])(
    "distinguishes an actual %s source before transcript commit",
    (kind) =>
      withCompletion(async ({ entry, request }) => {
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
          expect(await reconcileHarnessCompletionDelivery(request)).toBe(
            kind === "owned" ? "pending" : "blocked",
          );
        } finally {
          if (owner) {
            releaseAgentRunContext(announceId, owner);
          } else {
            clearAgentRunContext(announceId);
          }
        }
      }),
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
  ])("uses the real %s pre-execution registration", (kind) =>
    withCompletion(async ({ entry, request }) => {
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
        const result = await withPluginRuntimeGatewayRequestScope(
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
    }),
  );
});
