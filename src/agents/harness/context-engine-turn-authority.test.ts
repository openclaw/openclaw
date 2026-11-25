import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  addSessionMember,
  setSessionMemberAccess,
} from "../../config/sessions/session-sharing-store.native.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { withRecovery } from "../../gateway/operator-run-recovery.test-support.js";
import { rolePolicyConfig } from "../../gateway/session-sharing.test-utils.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
  readRunOperatorAuthority,
  readAdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { createTestOperatorAuthority } from "../admitted-run-context.test-support.js";
import {
  attachCompactionAccountingRecorder,
  readCompactionAccountingRecorder,
} from "../embedded-agent-runner/run/compaction-accounting-bridge.js";
import {
  participationAllowsTool,
  type BoundParticipationCeiling,
} from "../participation-ceiling.js";
import { waitForSessionMaintenance } from "../session-maintenance/coordinator.js";
import {
  captureCompletedTurnMessageAnchor,
  completedTurnMessageAnchor,
  sessionManagerReadMessageAnchor,
} from "../sessions/session-manager-message-anchor.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import {
  finalizeAcceptedContextEngineTurn,
  type ContextEngineTurnAttemptFacts,
} from "./context-engine-turn-attempt.js";
import { captureContextEngineTurnOperatorSource } from "./context-engine-turn-authority.js";
import { openContextEngineTurnOutboxWorkerStore } from "./context-engine-turn-outbox-store.js";
import {
  createTurnEngine,
  createTurnLease,
  finalizeTurn,
} from "./context-engine-turn.test-support.js";

async function recordTurn(
  target: { agentId: string; sessionId: string; sessionKey: string; storePath: string },
  engine: ContextEngine,
  runtimeContext: ContextEngineRuntimeContext | undefined,
  source: Parameters<typeof readRunOperatorAuthority>[0] = {},
) {
  const manager = await SessionManager.openAsync(target);
  const user = await manager.appendMessageWithTranscriptAnchorAsync({
    role: "user",
    content: "Question",
    timestamp: 1,
  });
  const anchor = manager[sessionManagerReadMessageAnchor](user.entryId)!;
  const terminal = await manager.appendMessageWithTranscriptAnchorAsync(
    makeAssistantMessageFixture({
      content: [{ type: "text", text: "Answer" }],
      stopReason: "stop",
      errorMessage: undefined,
      timestamp: 2,
    }),
  );
  const admission = { ...anchor, logicalTurnId: `${target.sessionId}-turn`, role: "user" as const };
  let facts: ContextEngineTurnAttemptFacts | undefined;
  await finalizeTurn({
    ...source,
    contextEngine: engine,
    sessionIdUsed: target.sessionId,
    sessionKey: target.sessionKey,
    sessionTarget: target,
    sessionFile: target.sessionKey,
    runtimeContext,
    providerId: "fixture",
    modelId: "fixture-model",
    tokenBudget: 900,
    turnCandidate: {
      admission,
      terminalEntryId: terminal.entryId,
      [completedTurnMessageAnchor]: captureCompletedTurnMessageAnchor(manager, terminal.entryId),
      record: (value) => {
        facts = value;
      },
    },
  });
  expect(facts).toBeDefined();
  return facts!;
}

it.each([
  { turnMaintenanceMode: "foreground", sourceState: "current" },
  { turnMaintenanceMode: "background", sourceState: "current" },
  { turnMaintenanceMode: "foreground", sourceState: "recovered" },
  { turnMaintenanceMode: "foreground", sourceState: "publication" },
  { turnMaintenanceMode: "foreground", sourceState: "missing" },
  { turnMaintenanceMode: "foreground", sourceState: "revoked" },
  { turnMaintenanceMode: "foreground", sourceState: "no-gateway" },
] as const)(
  "keeps the persisted participant source private and bounded ($turnMaintenanceMode, $sourceState)",
  async ({ turnMaintenanceMode, sourceState }) => {
    const config = rolePolicyConfig();
    config.gateway!.roles!.default = "invited";
    const role = config.gateway!.roles!.definitions.invited!;
    role.sessions.maxInvitedAccess = "send";
    role.sessions.invitedTools = ["read"];
    role.sessions.invitedPermission = "guarded";
    await withRecovery(
      async (fixture, _stateDir, profile) => {
        const target = {
          ...fixture.target,
          sessionKey: "agent:main:participant-root",
          sessionId: "participant-root",
        };
        resetCommandQueueStateForTest();
        config.session = { store: target.storePath };
        setRuntimeConfigSnapshot(config);
        await upsertSessionEntryCore(target, {
          ...fixture.entry,
          sessionId: target.sessionId,
          parentSessionKey: undefined,
          createdActor: { type: "human", source: "profile", id: "original-creator" },
          sessionRoot: "/synthetic/participant-root",
          permissionMode: "full",
          visibility: "read-only",
        });
        addSessionMember(target, {
          identityId: profile.id,
          addedBy: "original-creator",
          access: "send",
        });
        const ceiling: BoundParticipationCeiling = {
          kind: "send",
          profileId: profile.id,
          sessionKey: target.sessionKey,
          permission: "guarded",
          tools: ["read"],
          source: {
            agentId: "main",
            sessionId: target.sessionId,
            lifecycleRevision: "original-lifecycle",
            creatorProfileId: "original-creator",
            root: "/synthetic/participant-root",
          },
        };
        const restored = (await fixture.restore())!;
        const original = prepareSystemAgentRunAdmission(
          config,
          "original-turn",
          "main",
          "test",
          undefined,
          createAdmittedRunOperatorAuthority({
            ...restored.authority,
            ...(sourceState === "missing" ? { recoverySnapshot: undefined } : {}),
            participationCeiling: ceiling,
          }),
        );
        const runtimeContext = { provider: "fixture", modelId: "fixture-model" };
        const admittedRunContext = await original.admit("embedded");
        attachCompactionAccountingRecorder(runtimeContext, {
          operatorAuthority: readAdmittedRunOperatorAuthority(admittedRunContext),
        });
        const commitTurn = vi.fn<NonNullable<ContextEngine["commitTurn"]>>(async () => {
          throw new Error("hold persisted turn");
        });
        const entered = createDeferredCore();
        const finish = createDeferredCore();
        let maintenanceContext: ContextEngineRuntimeContext | undefined;
        let settledCeiling: BoundParticipationCeiling | undefined;
        const maintain = vi.fn<NonNullable<ContextEngine["maintain"]>>(async (params) => {
          if (params.sessionId === target.sessionId) {
            maintenanceContext = params.runtimeContext;
            entered.resolve();
            await finish.promise;
            const source = readCompactionAccountingRecorder(
              params.runtimeContext,
            )?.operatorAuthority;
            settledCeiling = source?.participationCeiling;
          }
          return { changed: false, bytesFreed: 0, rewrittenEntries: 0 };
        });
        const engine = {
          ...createTurnEngine(commitTurn),
          info: { ...createTurnEngine(commitTurn).info, turnMaintenanceMode },
          maintain,
        };
        const lease = {
          ...createTurnLease(engine),
          deferDisposalUntil: vi.fn<(promise: Promise<unknown>) => void>(),
        };
        // Durable embedded attempts supply their host admission without public runtime metadata.
        const facts =
          sourceState === "current" && turnMaintenanceMode === "foreground"
            ? await recordTurn(target, engine, undefined, { admittedRunContext })
            : await recordTurn(target, engine, runtimeContext);
        const warn = vi.fn();
        const store = openContextEngineTurnOutboxWorkerStore({
          agentId: "main",
          path: facts.boundary.admission.storePath,
        });
        if (sourceState === "recovered" || sourceState === "publication") {
          await store.acceptIntent({
            engineId: "test",
            boundary: facts.boundary,
            runtimeContext: facts.runtimeContext,
            operatorSource: facts.operatorSource,
          });
          const accepted = await store.readNextPending({
            engineId: "test",
            sessionId: target.sessionId,
          });
          expect(JSON.parse(accepted!.payload_json)).toMatchObject({
            state: "accepted",
            operatorSource: facts.operatorSource,
          });
          if (sourceState === "recovered") {
            await store.prepareRun({ engineId: "test", sessionId: target.sessionId });
          } else {
            // A publication caller with no source cannot erase accepted custody.
            await store.publishClosedTurn({
              engineId: "test",
              boundary: facts.boundary,
              runtimeContext: facts.runtimeContext,
              maxBytes: 1_000_000,
              maxEvents: 100,
            });
          }
        } else {
          await finalizeAcceptedContextEngineTurn({ facts, lease, config, warn });
        }
        const row = await store.readNextPending({
          engineId: "test",
          sessionId: target.sessionId,
        });
        expect(row, JSON.stringify(warn.mock.calls)).toBeDefined();
        const payload = JSON.parse(row!.payload_json);
        try {
          expect(payload.operatorSource).toMatchObject(
            sourceState === "missing"
              ? { kind: "unavailable" }
              : { kind: "gateway", snapshot: { version: 2, participationCeiling: ceiling } },
          );
          expect(payload.runtimeContext).toEqual({
            provider: "fixture",
            modelId: "fixture-model",
            tokenBudget: 900,
          });
          original.close();
          restored.release();
          role.sessions.invitedTools = ["read", "write", "exec"];
          role.sessions.invitedPermission = "full";
          if (sourceState === "revoked") {
            setSessionMemberAccess(target, { identityId: profile.id, access: "read" });
          }
          setRuntimeConfigSnapshot(config);
          const trigger = {
            ...target,
            sessionKey: "agent:main:drainer",
            sessionId: "drainer",
          };
          await upsertSessionEntryCore(trigger, { sessionId: trigger.sessionId, updatedAt: 1 });
          const triggerFacts = await recordTurn(trigger, engine, {
            operatorSource: facts.operatorSource,
          });
          commitTurn.mockImplementation(async () => ({ status: "committed" }));
          const completion = withPluginRuntimeGatewayRequestScope(
            {
              context: sourceState === "no-gateway" ? undefined : fixture.context,
              isWebchatConnect: () => false,
            },
            () => finalizeAcceptedContextEngineTurn({ facts: triggerFacts, lease, config, warn }),
          );
          await Promise.race([
            entered.promise,
            completion.then(async () => {
              await waitForSessionMaintenance(target.sessionKey);
            }),
          ]);
          if (
            sourceState === "missing" ||
            sourceState === "revoked" ||
            sourceState === "no-gateway"
          ) {
            await completion;
            expect(maintenanceContext).toBeUndefined();
            expect(warn).toHaveBeenCalledWith(
              expect.stringContaining("skipped accepted turn advancement"),
            );
            expect(maintain.mock.calls.map(([call]) => call.sessionId)).toEqual([
              trigger.sessionId,
            ]);
            return;
          }
          expect(maintenanceContext, JSON.stringify(warn.mock.calls)).toBeDefined();
          const recorder = readCompactionAccountingRecorder(maintenanceContext);
          const authority = recorder?.operatorAuthority;
          expect(authority?.participationCeiling).toMatchObject(ceiling);
          expect(participationAllowsTool(authority!.participationCeiling!, "write")).toBe(false);
          expect(maintenanceContext).not.toHaveProperty("operatorSource");
          expect(maintenanceContext).not.toHaveProperty("admittedRunContext");
          expect(maintenanceContext).not.toHaveProperty("participationCeiling");
          for (const [call] of commitTurn.mock.calls) {
            expect(call).not.toHaveProperty("operatorSource");
            expect(readCompactionAccountingRecorder(call.runtimeContext)).toBeUndefined();
          }
          if (turnMaintenanceMode === "background") {
            await completion;
            expect(() => authority?.retain?.()?.()).not.toThrow();
          }
          finish.resolve();
          await completion;
          await waitForSessionMaintenance(target.sessionKey);
          await Promise.all(lease.deferDisposalUntil.mock.calls.map(([promise]) => promise));
          expect(settledCeiling?.permission).toBe("guarded");
          expect(participationAllowsTool(settledCeiling!, "exec")).toBe(false);
          expect(() => authority?.retain?.()).toThrow(/closed|no longer active|released/);
          const ordinary = maintain.mock.calls.find(
            ([call]) => call.sessionId === trigger.sessionId,
          )![0];
          expect(
            readCompactionAccountingRecorder(ordinary.runtimeContext)?.operatorAuthority,
          ).toBeUndefined();
        } finally {
          finish.resolve();
          original.close();
          restored.release();
          await waitForSessionMaintenance(target.sessionKey);
          resetCommandQueueStateForTest();
        }
      },
      { config, scopes: ["operator.read", "operator.write", "operator.sessions.write"] },
    );
  },
);

it.each(["admission", "recorder"] as const)(
  "leaves ordinary operator maintenance model-only via %s without a recovery source",
  async (route) => {
    const authority = createTestOperatorAuthority({
      canonicalIdentity: null,
      profileId: "ordinary-owner",
      scopes: ["operator.admin"],
    });
    const preparation = prepareSystemAgentRunAdmission(
      {},
      "ordinary-maintenance",
      "main",
      "test",
      undefined,
      authority,
    );
    try {
      const admittedRunContext = await preparation.admit("embedded");
      const runtimeContext = {
        provider: "fixture",
        modelId: "model",
        operatorSource: { kind: "unavailable" },
      };
      if (route === "recorder") {
        attachCompactionAccountingRecorder(runtimeContext, {
          operatorAuthority: readAdmittedRunOperatorAuthority(admittedRunContext),
        });
      }
      expect(
        captureContextEngineTurnOperatorSource(
          runtimeContext,
          route === "admission" ? { admittedRunContext } : {},
        ),
      ).toBeUndefined();
    } finally {
      preparation.close();
    }
  },
);
