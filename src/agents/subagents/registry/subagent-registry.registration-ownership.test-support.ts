import { expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { callGateway } from "../../../gateway/call.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryChangesToSqlite,
} from "./subagent-registry-state.fixture.test-support.js";
import { registerSubagentRun } from "./subagent-registry.js";
import type { SubagentRegistrationScope, SubagentRunRecord } from "./subagent-registry.types.js";
import { deleteSubagentSessionForCleanup } from "./subagent-session-cleanup.js";

type Registration = Parameters<typeof registerSubagentRun>[0];

export function registerSubagentRegistrationOwnershipTests({
  registration,
  updateRun,
}: {
  registration: (runId: string, overrides?: Partial<Registration>) => Registration;
  updateRun: (runId: string, update: (draft: SubagentRunRecord) => void) => Promise<void>;
}) {
  for (const phase of ["ordinary intent", "queued intent", "queued descriptor"] as const) {
    it.each([
      "persisted owner",
      "persisted unknown owner",
      "persisted unknown incarnation",
      "resident owner",
      "other agent",
      "no sibling",
    ])(
      "preserves retained sibling session and transcript after refused " + phase + " (%s)",
      async (sibling) => {
        await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
          const session = {
            agentId: "main",
            sessionKey: "global",
            sessionId: "retained-child",
            storePath: state.path("retained-sessions.sqlite"),
          };
          const sessionEntry = {
            sessionId: session.sessionId,
            lifecycleRevision: "retained-incarnation",
            updatedAt: Date.now(),
          };
          await replaceSessionEntry(session, sessionEntry);
          await appendTranscriptMessage(session, {
            message: { role: "assistant", content: "Retained sibling result" },
          });
          const transcript = await loadTranscriptEvents(session);
          expect(transcript.length).toBeGreaterThan(0);
          const retained = createSubagentRunRecord({
            runId: "retained-sibling",
            childSessionKey: session.sessionKey,
            childAgentId:
              sibling === "persisted unknown owner"
                ? undefined
                : sibling === "other agent"
                  ? "research"
                  : session.agentId,
            childSessionIdentity:
              sibling === "persisted unknown incarnation" ? undefined : sessionEntry,
            generation: 7,
          });
          if (sibling !== "no sibling") {
            saveSubagentRegistryChangesToSqlite(new Map([[retained.runId, retained]]), [
              retained.runId,
            ]);
          }
          if (sibling === "resident owner") {
            subagentRuns.set(retained.runId, retained);
          } else {
            expect(subagentRuns.has(retained.runId)).toBe(false);
          }
          const before = loadSubagentRegistryFromSqlite().get(retained.runId);
          let writes = 0;
          const refusal = probe.command(stateWorker, async (command, options, scope) => {
            if (
              command.type === "subagents.persistChanges" &&
              ++writes === (phase === "queued descriptor" ? 2 : 1)
            ) {
              throw new Error("registration write refused");
            }
            return scope.execute(command, options);
          });
          let ownership: SubagentRegistrationScope | undefined;
          try {
            await expect(
              registerSubagentRun(
                registration("refused-follow-up", {
                  childSessionKey: session.sessionKey,
                  sessionEntry,
                  collect: true,
                  queued: phase !== "ordinary intent",
                  queuedLaunch: {
                    request: { sessionKey: session.sessionKey },
                    timeoutMs: 100,
                    schedulerGroupKey: "retained-group",
                    maxConcurrent: 1,
                  },
                }),
                {
                  retainOwnership: (scope) => {
                    ownership = scope;
                  },
                },
              ),
            ).rejects.toThrow("registration write refused");
          } finally {
            refusal.mockRestore();
          }
          if (!ownership) {
            throw new Error("Refused registration did not retain its cleanup scope");
          }
          const cleanup = await deleteSubagentSessionForCleanup({
            childSessionKey: session.sessionKey,
            childAgentId: session.agentId,
            expectedSessionId: sessionEntry.sessionId,
            expectedLifecycleRevision: sessionEntry.lifecycleRevision,
            isCurrent: ownership.canCleanupSession,
            callGateway: async (request) => {
              request.assertDispatchCurrent?.();
              return deleteSessionEntryLifecycle({
                agentId: session.agentId,
                storePath: session.storePath,
                target: { canonicalKey: session.sessionKey, storeKeys: [session.sessionKey] },
                expectedSessionId: request.params.expectedSessionId,
                expectedLifecycleRevision: request.params.expectedLifecycleRevision,
                archiveTranscript: false,
                deleteTranscriptWithoutArchive: true,
                commitGuard: request.assertDispatchCurrent,
              });
            },
          });
          expect(loadSubagentRegistryFromSqlite().get(retained.runId)).toEqual(before);
          if (sibling === "other agent" || sibling === "no sibling") {
            expect(cleanup).toBe("deleted");
            expect(loadSessionEntry(session)).toBeUndefined();
            expect(await loadTranscriptEvents(session)).toEqual([]);
          } else {
            expect(loadSessionEntry(session)).toMatchObject(sessionEntry);
            expect(await loadTranscriptEvents(session)).toEqual(transcript);
            expect(cleanup).toBe("failed");
            expect(ownership.canCleanupSession()).toBe(false);
          }
        });
      },
    );
  }

  it.each(["resident", "persisted only"])(
    "uses %s unknown-owner generations as a floor without superseding their retained obligations",
    async (source) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await registerSubagentRun(registration("unknown-global", { childSessionKey: "global" }));
        await updateRun("unknown-global", (draft) => {
          delete draft.childAgentId;
          draft.generation = 7;
          draft.killReconciliation = { killedAt: 1 };
        });
        const unknown = loadSubagentRegistryFromSqlite().get("unknown-global");
        await registerSubagentRun(
          registration("other-global", { childSessionKey: "global", childAgentId: "research" }),
        );
        await updateRun("other-global", (draft) => {
          draft.generation = 50;
        });
        if (source === "persisted only") {
          subagentRuns.delete("unknown-global");
          subagentRuns.delete("other-global");
        }
        let ownership: SubagentRegistrationScope | undefined;
        await registerSubagentRun(registration("owned-global", { childSessionKey: "global" }), {
          retainOwnership: (scope) => {
            ownership = scope;
          },
        });
        const persisted = loadSubagentRegistryFromSqlite();
        expect(persisted.get("owned-global")?.generation).toBe(8);
        expect(persisted.get("unknown-global")).toEqual(unknown);
        expect(ownership?.canLaunch()).toBe(true);
      });
    },
  );

  it.each(["appears", "loses its recorded owner"])(
    "refuses registration when a foreign same-key row %s after cohort preparation",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const unknown = createSubagentRunRecord({
          runId: "foreign-unknown",
          childSessionKey: "global",
          generation: 7,
        });
        if (change === "loses its recorded owner") {
          saveSubagentRegistryChangesToSqlite(
            new Map([[unknown.runId, { ...unknown, childAgentId: "research" }]]),
            [unknown.runId],
          );
        }
        const execute = stateWorker.runOpenClawStateWorkerOperation;
        let inserted = false;
        const foreignWrite = vi
          .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
          .mockImplementation((context, operation, options) =>
            execute(
              context,
              (scope) =>
                operation({
                  execute: async (...args) => {
                    if (!inserted && args[0].type === "subagents.persistChanges") {
                      inserted = true;
                      saveSubagentRegistryChangesToSqlite(new Map([[unknown.runId, unknown]]), [
                        unknown.runId,
                      ]);
                    }
                    return scope.execute(...args);
                  },
                }),
              options,
            ),
          );
        let ownership: SubagentRegistrationScope | undefined;
        try {
          await expect(
            registerSubagentRun(registration("racing-global", { childSessionKey: "global" }), {
              retainOwnership: (scope) => {
                ownership = scope;
              },
            }),
          ).rejects.toThrow("registry rows changed");
          const persisted = loadSubagentRegistryFromSqlite();
          expect(persisted.has("racing-global")).toBe(false);
          expect(persisted.get(unknown.runId)).toMatchObject({
            generation: 7,
            childSessionKey: "global",
          });
          expect(persisted.get(unknown.runId)?.childAgentId).toBeUndefined();
          expect(subagentRuns.has("racing-global")).toBe(false);
          expect(ownership?.canCleanupSession()).toBe(false);
          expect(callGateway).not.toHaveBeenCalled();
        } finally {
          foreignWrite.mockRestore();
        }
        await registerSubagentRun(registration("racing-global", { childSessionKey: "global" }));
        expect(loadSubagentRegistryFromSqlite().get("racing-global")?.generation).toBe(8);
      });
    },
  );

  it.each(["global", "agent:research:subagent:owned-child"])(
    "persists the explicit child owner and original incarnation for %s",
    async (childSessionKey) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const params = registration("owned-registration", {
          childSessionKey,
          childAgentId: "RESEARCH",
          sessionEntry: { sessionId: "original-child", lifecycleRevision: "original-revision" },
        });
        await registerSubagentRun(params);
        expect(loadSubagentRegistryFromSqlite().get(params.runId)).toMatchObject({
          childSessionKey,
          childAgentId: "research",
          childSessionIdentity: params.sessionEntry,
        });
      });
    },
  );

  it.each([
    { childSessionKey: "global", childAgentId: undefined },
    { childSessionKey: "agent:main:subagent:unbound", childAgentId: undefined },
    { childSessionKey: "global", childAgentId: "research!" },
    { childSessionKey: "agent:main:subagent:conflicting", childAgentId: "research" },
    { childSessionKey: "agent:research!:subagent:malformed", childAgentId: "research" },
  ])(
    "refuses invalid new registration ownership: $childSessionKey / $childAgentId",
    async (owner) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const params = registration("invalid-owner", owner);
        await expect(registerSubagentRun(params)).rejects.toThrow("child agent");
        expect(subagentRuns.has(params.runId)).toBe(false);
        expect(loadSubagentRegistryFromSqlite().has(params.runId)).toBe(false);
        expect(callGateway).not.toHaveBeenCalled();
      });
    },
  );

  it.each([undefined, { sessionId: "" }, { sessionId: " \t\n " }])(
    "refuses new registration without its original child incarnation %j",
    async (sessionEntry) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const params = registration("missing-incarnation", { sessionEntry });
        await expect(registerSubagentRun(params)).rejects.toThrow("original child sessionId");
        expect(subagentRuns.has(params.runId)).toBe(false);
        expect(loadSubagentRegistryFromSqlite().has(params.runId)).toBe(false);
        expect(callGateway).not.toHaveBeenCalled();
      });
    },
  );

  it.each([true, undefined] as const)(
    "preserves historical ownership on replay or replacement (replay=%s)",
    async (acceptedRunReplay) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        for (const childSessionKey of ["global", "agent:main:subagent:historical"]) {
          const params = registration(`historical-${childSessionKey}`, { childSessionKey });
          await registerSubagentRun(params);
          await updateRun(params.runId, (draft) => {
            delete draft.childAgentId;
          });
          const historical = loadSubagentRegistryFromSqlite().get(params.runId);
          subagentRuns.delete(params.runId);
          vi.mocked(callGateway).mockClear();
          if (childSessionKey === "global") {
            let ownership: SubagentRegistrationScope | undefined;
            await expect(
              registerSubagentRun(params, {
                acceptedRunReplay,
                retainOwnership: (scope) => {
                  ownership = scope;
                },
              }),
            ).rejects.toThrow("unresolved or different child owner");
            expect(loadSubagentRegistryFromSqlite().get(params.runId)).toEqual(historical);
            expect(callGateway).not.toHaveBeenCalled();
            expect(ownership?.canAbortAcceptedRun()).toBe(false);
            expect(ownership?.canCleanupSession()).toBe(false);
          } else {
            await registerSubagentRun(params, { acceptedRunReplay });
            const stored = loadSubagentRegistryFromSqlite().get(params.runId);
            if (acceptedRunReplay) {
              expect(stored).toEqual(historical);
              expect(callGateway).not.toHaveBeenCalled();
            } else {
              expect(stored?.childAgentId).toBe("main");
            }
          }
        }
      });
    },
  );
}
