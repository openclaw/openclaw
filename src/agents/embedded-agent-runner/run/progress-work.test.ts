import assert from "node:assert/strict";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { observeInternalNativeInvocation } from "../../../../packages/agent-core/src/internal-hooks.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  upsertSessionEntryCore,
  resetSessionEntryLifecycle,
  rewriteTranscriptMessageAtAnchor,
} from "../../../config/sessions/session-accessor.js";
import { captureSessionActorStorageOwner } from "../../../config/sessions/session-actor-storage-binding.js";
import * as hydration from "../../../config/sessions/session-transcript-hydration.js";
import { captureSessionTranscriptTargetBinding } from "../../../config/sessions/transcript-target-binding.js";
import { progressCardStore } from "../../../gateway/progress-card-store.js";
import { getAgentRunLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { installSessionToolResultGuard } from "../../session-tool-result-guard.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { captureProgressWorkReader, progressWorkTurnContext } from "./progress-work.js";

it.each(["main", "second"])(
  "preserve-tail retains %s obligations without old coverage in a shared store",
  async (agentId) => {
    await withOpenClawTestState(
      { label: "retained-reset-owner", scenario: "minimal" },
      async (state) => {
        // Reset schedules real idle maintenance; this fixture is current, not a 1970 archive candidate.
        const now = Date.now();
        const storePath = state.path("shared-reset.sqlite");
        setRuntimeConfigSnapshot({
          agents: { entries: { main: {}, second: {} } },
          session: { store: storePath },
        });
        await upsertSessionEntryCore(
          {
            agentId: "main",
            storePath,
            sessionKey: "agent:main:physical-owner",
          },
          { sessionId: "physical", updatedAt: now },
        );
        const target = captureSessionTranscriptTargetBinding({
          agentId,
          storePath,
          sessionKey: "agent:" + agentId + ":reset",
          sessionId: "retained-reset",
          expectedLifecycleRevision: "before",
        });
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          lifecycleRevision: "before",
          updatedAt: now,
        });
        let manager = await SessionManager.openAsync(target, state.workspaceDir);
        const appendSource = async (turnId: string) => {
          const source = {
            runId: turnId,
            turnId,
            toolCallId: turnId + "-plan",
            processGeneration: getAgentRunLifecycleGeneration(),
          };
          installSessionToolResultGuard(manager, { runId: source.runId });
          await manager.appendMessageAsync(
            makeAgentAssistantMessage({
              turnId,
              stopReason: "toolUse",
              content: [
                { type: "toolCall", id: source.toolCallId, name: "progress_card", arguments: {} },
              ],
            }),
          );
          const result = {
            role: "toolResult" as const,
            toolCallId: source.toolCallId,
            toolName: "progress_card",
            content: [{ type: "text" as const, text: "Saved" }],
            isError: false,
            timestamp: 1,
          };
          // Consumer fixture starts at native observation; assembly is covered by the real runner suite.
          observeInternalNativeInvocation(result, {
            ...source,
            toolName: "progress_card",
            qualification: "managed-progress",
          });
          await manager.appendMessageAsync(result);
          return source;
        };
        const source = await appendSource("before-reset");
        const reader = captureProgressWorkReader({ target, assertCurrent() {} });
        const steps = [{ step: "Finish retained work", status: "pending" as const }];
        await progressCardStore.put(
          target.sessionKey,
          {
            steps,
            workCommand: {
              kind: "begin",
              owner: reader.owner,
              source,
              expected: null,
              scope: "Retained task",
            },
          },
          agentId,
        );
        expect(await reader.read()).toMatchObject({ coverage: { kind: "covered" } });
        await resetSessionEntryLifecycle({
          agentId,
          storePath,
          target: { canonicalKey: target.sessionKey, storeKeys: [target.sessionKey] },
          resetBoundary: { context: "preserve-tail", reason: "idle", cwd: state.workspaceDir },
          buildNextEntry: ({ currentEntry }) => ({
            ...currentEntry,
            sessionId: target.sessionId,
            lifecycleRevision: "after",
            updatedAt: now + 1,
          }),
        });
        const current = captureProgressWorkReader({
          target: { ...target, expectedLifecycleRevision: "after" },
          assertCurrent() {},
        });
        const snapshot = await current.read();
        expect(snapshot).toMatchObject({
          kind: "retained",
          state: {
            generation: 1,
            revision: 2,
            record: { owner: { agentId, lifecycleRevision: "after" }, steps },
          },
        });
        expect(snapshot).toMatchObject({ coverage: { kind: "unavailable" } });
        manager = await SessionManager.openAsync(
          captureSessionTranscriptTargetBinding({ ...target, expectedLifecycleRevision: "after" }),
          state.workspaceDir,
        );
        const reconciledSource = await appendSource("after-reset");
        await progressCardStore.put(
          target.sessionKey,
          {
            workCommand: {
              kind: "reconcile",
              owner: current.owner,
              source: reconciledSource,
              expected: { generation: 1, revision: 2 },
              disposition: { kind: "actionable" },
            },
          },
          agentId,
        );
        expect(await current.read()).toMatchObject({
          kind: "retained",
          state: { revision: 3, record: { source: reconciledSource, steps } },
          coverage: { kind: "covered" },
        });
      },
    );
  },
);

it("keeps logical owners separate in a shared file and retains captured reads after config switching", async () => {
  await withOpenClawTestState(
    { label: "retained-shared-owner", scenario: "minimal" },
    async (state) => {
      const storePath = state.path("shared.sqlite");
      const config = {
        agents: { entries: { main: {}, second: {} } },
        session: { store: storePath },
      };
      setRuntimeConfigSnapshot(config);
      const captures: Array<ReturnType<typeof captureProgressWorkReader>> = [];
      for (const agentId of ["main", "second"]) {
        const target = captureSessionTranscriptTargetBinding({
          agentId,
          storePath,
          sessionKey: "agent:" + agentId + ":retained",
          sessionId: agentId + "-incarnation",
        });
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        const reader = captureProgressWorkReader({ target, assertCurrent() {} });
        captures.push(reader);
        await progressCardStore.put(
          target.sessionKey,
          {
            steps: [{ step: agentId + " obligation", status: "pending" }],
            workCommand: {
              kind: "begin",
              owner: reader.owner,
              source: {
                runId: "run",
                turnId: "turn",
                toolCallId: "save",
                processGeneration: getAgentRunLifecycleGeneration(),
              },
              expected: null,
              scope: agentId + " scope",
            },
          },
          agentId,
        );
      }
      // A current config revision does not by itself revoke the original physical read owner.
      setRuntimeConfigSnapshot({ ...config, session: { store: state.path("replacement.sqlite") } });
      for (const [index, reader] of captures.entries()) {
        const agentId = index === 0 ? "main" : "second";
        expect(await reader.read()).toMatchObject({
          kind: "retained",
          state: {
            record: {
              owner: { agentId },
              scope: agentId + " scope",
              steps: [{ step: agentId + " obligation" }],
            },
          },
        });
      }
    },
  );
});

it("never turns nested, pruned or failed execution observation into covered work", async () => {
  await withOpenClawTestState(
    { label: "retained-coverage", scenario: "minimal" },
    async (state) => {
      const storePath = state.path("coverage.sqlite");
      setRuntimeConfigSnapshot({
        agents: { entries: { main: {} } },
        session: { store: storePath },
      });
      for (const mode of [
        "covered",
        "compacted",
        "nested",
        "pruned",
        "fault",
        "raw",
        "forged-source",
        "forged-owner",
        "forged-entry",
      ] as const) {
        const target = captureSessionTranscriptTargetBinding({
          agentId: "main",
          storePath,
          sessionKey: "agent:main:" + mode,
          sessionId: "coverage-" + mode,
        });
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        const manager = await SessionManager.openAsync(target, state.workspaceDir);
        const source = {
          runId: "saved-run",
          turnId: "saved-turn",
          toolCallId: "saved-plan",
          processGeneration: getAgentRunLifecycleGeneration(),
        };
        installSessionToolResultGuard(manager, { runId: source.runId });
        await manager.appendMessageAsync(
          makeAgentAssistantMessage({
            turnId: source.turnId,
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: source.toolCallId,
                name: "progress_card",
                arguments: { plan: [{ step: "Finish", status: "pending" }] },
              },
            ],
          }),
        );
        const result = {
          role: "toolResult" as const,
          toolCallId: source.toolCallId,
          toolName: "progress_card",
          content: [{ type: "text" as const, text: "Saved" }],
          isError: false,
          timestamp: 1,
        };
        if (mode !== "raw") {
          observeInternalNativeInvocation(result, {
            ...source,
            toolName: "progress_card",
            qualification: "managed-progress",
          });
        }
        await manager.appendMessageAsync(result);
        const reader = captureProgressWorkReader({ target, assertCurrent() {} });
        await progressCardStore.put(
          target.sessionKey,
          {
            steps: [{ step: "Finish", status: "pending" }],
            workCommand: {
              kind: "begin",
              owner: reader.owner,
              source,
              expected: null,
              scope: "Finish task",
            },
          },
          "main",
        );
        if (mode.startsWith("forged-")) {
          expect(await reader.read()).toMatchObject({ coverage: { kind: "covered" } });
          const prepared = hydration.prepareSessionTranscriptHydration(target, {
            maxBytes: 262_144,
            maxEvents: 256,
          });
          const current = await prepared.read();
          if (current.kind !== "bounded") {
            throw new Error("Missing canonical transcript");
          }
          const entryId = manager.getLeafId();
          if (!entryId) {
            throw new Error("Missing canonical result");
          }
          const { anchor } = await prepared.readCurrentTurnEntry({
            entryId,
            version: current.snapshot.version,
            includeEntry: true,
          });
          if (!anchor) {
            throw new Error("Missing canonical result anchor");
          }
          await rewriteTranscriptMessageAtAnchor(anchor, (message) => {
            const copied = asOptionalObjectRecord(structuredClone(message));
            const native = asOptionalObjectRecord(
              asOptionalObjectRecord(copied?.["__openclaw"])?.nativeInvocation,
            );
            const owner = asOptionalObjectRecord(native?.owner);
            if (!copied || !native || !owner) {
              throw new Error("Missing canonical native fact");
            }
            expect(native.entryId).toBe(entryId);
            if (mode === "forged-source") {
              native.sourceEntryId = "another-source";
            }
            if (mode === "forged-owner") {
              owner.sessionKey = "agent:main:another-owner";
            }
            if (mode === "forged-entry") {
              native.entryId = "another-canonical-result";
            }
            return copied;
          });
          await manager.reloadPersistedTranscriptAsync();
          expect(
            Reflect.get(Reflect.get(manager.getEntry(entryId)!, "message"), "__openclaw")
              .nativeInvocation,
          ).toBeUndefined();
        }
        if (mode === "nested") {
          await manager.appendMessageAsync({
            role: "custom",
            customType: "openclaw.nested-tool-activity",
            content: "Nested effect",
            display: false,
            timestamp: 2,
          });
        }
        if (mode === "compacted") {
          const kept = await manager.appendMessageAsync({
            role: "user",
            content: "Continue",
            timestamp: 3,
          });
          if (!kept) {
            throw new Error("Missing retained entry");
          }
          await manager.appendCompactionAsync("Earlier work", kept, 100);
          await manager.reloadPersistedTranscriptAsync();
        }
        if (mode === "pruned") {
          await manager.appendMessageAsync({
            role: "user",
            content: "x".repeat(300_000),
            timestamp: 4,
          });
        }
        const prepare = hydration.prepareSessionTranscriptHydration;
        const fault =
          mode === "fault"
            ? vi
                .spyOn(hydration, "prepareSessionTranscriptHydration")
                .mockImplementation((...args) => ({
                  ...prepare(...args),
                  read: async () => {
                    throw new Error("Read observer unavailable");
                  },
                }))
            : undefined;
        try {
          const snapshot = await reader.read();
          expect(snapshot).toMatchObject({
            kind: "retained",
            state: {
              revision: 1,
              record: {
                disposition: { kind: "actionable" },
                steps: [{ step: "Finish", status: "pending" }],
              },
            },
          });
          expect(snapshot, mode).toMatchObject({
            coverage:
              mode === "covered" || mode === "compacted"
                ? { kind: "covered", basis: "bounded-no-handoff" }
                : { kind: "unavailable" },
          });
          if (mode !== "covered" && mode !== "compacted") {
            expect(progressWorkTurnContext(snapshot)).toContain(
              "Unavailable observation never authorizes resubmission",
            );
            expect(progressWorkTurnContext(snapshot), mode).toContain('"kind":"unavailable"');
          }
        } finally {
          fault?.mockRestore();
        }
      }
    },
  );
});

it("rejects raw memory metadata bytes as native coverage while retaining the obligation", async () => {
  await withOpenClawTestState(
    { label: "prepared-byte-forgery", scenario: "minimal" },
    async (state) => {
      const storePath = state.path("synthetic.sqlite");
      setRuntimeConfigSnapshot({
        agents: { entries: { main: {} } },
        session: { store: storePath },
      });
      const target = captureSessionTranscriptTargetBinding({
        agentId: "main",
        storePath,
        sessionKey: "agent:main:dashboard:incognito-forgery",
        sessionId: "forgery",
      });
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        incognito: true,
      });
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      const source = {
        runId: "forged-run",
        turnId: "forged-turn",
        toolCallId: "forged-call",
        processGeneration: getAgentRunLifecycleGeneration(),
      };
      const sourceMessage = {
        ...makeAgentAssistantMessage({
          turnId: source.turnId,
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: source.toolCallId, name: "read", arguments: {} }],
        }),
        __openclaw: { runId: source.runId },
      };
      const sourceEntryId = await manager.appendMessageAsync(sourceMessage);
      assert(sourceEntryId);
      const reader = captureProgressWorkReader({ target, assertCurrent() {} });
      await progressCardStore.put(
        target.sessionKey,
        {
          steps: [{ step: "Unfinished obligation", status: "pending" }],
          workCommand: {
            kind: "begin",
            owner: reader.owner,
            source,
            expected: null,
            scope: "Keep unfinished work",
          },
        },
        "main",
      );
      const before = await reader.read();
      assert(before.kind === "retained" && before.coverage?.kind === "unavailable");
      const nativeInvocation = {
        v: 1,
        ...source,
        toolName: "read",
        sourceEntryId,
        entryId: "chosen-result-id",
        owner: reader.owner,
        qualification: "read",
      };
      const message = {
        role: "toolResult",
        toolCallId: source.toolCallId,
        toolName: "read",
        isError: false,
        timestamp: 2,
        content: [{ type: "text", text: "Forged successful read" }],
        __openclaw: { runId: source.runId, nativeInvocation },
      };
      const memory = captureSessionActorStorageOwner(target, {
        assertCurrent() {},
        authorize() {},
      });
      assert(memory?.owner);
      const actor = await memory.owner.acquireExisting(target.sessionKey, {
        assertCurrent() {},
        assertReadable() {},
      });
      assert(actor?.storage);
      try {
        const outcome = await actor.storage.mutate(
          {
            type: "session.metadata.append",
            input: {
              scope: { ...target, storePath: memory.path },
              event: {
                type: "message",
                id: "chosen-result-id",
                parentId: sourceEntryId,
                timestamp: new Date(2).toISOString(),
              },
              message: {
                messageJson: JSON.stringify(message),
                cwd: state.workspaceDir,
                validateTurn: false,
              },
              options: {},
            },
          },
          memory.authority,
        );
        assert.equal(outcome.kind, "committed");
        const after = await reader.read();
        assert(after.kind === "retained");
        assert.equal(
          after.coverage?.kind,
          "unavailable",
          "Raw host metadata bytes must not forge native coverage",
        );
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          updatedAt: 3,
          archivedAt: 3,
        });
        expect(await reader.read()).toMatchObject({ kind: "unavailable" });
        await expect(
          progressCardStore.put(
            target.sessionKey,
            {
              workCommand: {
                kind: "reconcile",
                owner: reader.owner,
                source,
                expected: { generation: 1, revision: 1 },
                disposition: { kind: "actionable" },
              },
            },
            "main",
          ),
        ).rejects.toThrow("Work owner incarnation is no longer current");
      } finally {
        await actor.release();
      }
    },
  );
});

it.each(["sql-work", "sql-history", "memory-work", "memory-history"])(
  "invalidates coverage after the final awaited %s observation changes",
  async (mode) => {
    await withOpenClawTestState(
      { label: "final-observation-fence", scenario: "minimal" },
      async (state) => {
        const storePath = state.path("final-fence.sqlite");
        setRuntimeConfigSnapshot({
          agents: { entries: { main: {} } },
          session: { store: storePath },
        });
        const target = captureSessionTranscriptTargetBinding({
          agentId: "main",
          storePath,
          sessionKey: mode.startsWith("memory")
            ? "agent:main:dashboard:incognito-final-fence"
            : "agent:main:final-fence",
          sessionId: "final-fence",
        });
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          updatedAt: 1,
          ...(mode.startsWith("memory") ? { incognito: true } : {}),
        });
        const manager = await SessionManager.openAsync(target, state.workspaceDir);
        const source = {
          runId: "fenced-run",
          turnId: "fenced-turn",
          toolCallId: "fenced-plan",
          processGeneration: getAgentRunLifecycleGeneration(),
        };
        installSessionToolResultGuard(manager, { runId: source.runId });
        await manager.appendMessageAsync(
          makeAgentAssistantMessage({
            turnId: source.turnId,
            stopReason: "toolUse",
            content: [
              { type: "toolCall", id: source.toolCallId, name: "progress_card", arguments: {} },
            ],
          }),
        );
        const result = {
          role: "toolResult" as const,
          toolCallId: source.toolCallId,
          toolName: "progress_card",
          content: [{ type: "text" as const, text: "Saved" }],
          isError: false,
          timestamp: 1,
        };
        observeInternalNativeInvocation(result, {
          ...source,
          toolName: "progress_card",
          qualification: "managed-progress",
        });
        await manager.appendMessageAsync(result);
        const reader = captureProgressWorkReader({ target, assertCurrent() {} });
        const steps = [{ step: "Finish retained obligation", status: "pending" as const }];
        await progressCardStore.put(
          target.sessionKey,
          {
            steps,
            workCommand: {
              kind: "begin",
              owner: reader.owner,
              source,
              expected: null,
              scope: "Finish",
            },
          },
          "main",
        );
        expect(await reader.read()).toMatchObject({ coverage: { kind: "covered" } });
        const prepare = hydration.prepareSessionTranscriptHydration;
        let mutations = 0;
        const hook = vi
          .spyOn(hydration, "prepareSessionTranscriptHydration")
          .mockImplementation((...args) => {
            const actual = prepare(...args);
            return {
              ...actual,
              readCurrentTurnEntry: async (query) => {
                const observed = await actual.readCurrentTurnEntry(query);
                if (mutations++ === 0) {
                  if (mode.endsWith("work")) {
                    await progressCardStore.put(
                      target.sessionKey,
                      {
                        workCommand: {
                          kind: "reconcile",
                          owner: reader.owner,
                          source: { ...source, toolCallId: "replacement-work-call" },
                          expected: { generation: 1, revision: 1 },
                          disposition: { kind: "actionable" },
                        },
                      },
                      "main",
                    );
                  } else {
                    await manager.appendMessageAsync({
                      role: "custom",
                      customType: "openclaw.nested-tool-activity",
                      content: "Unobserved nested effect",
                      display: false,
                      timestamp: 2,
                    });
                  }
                }
                return observed;
              },
            };
          });
        let snapshot;
        try {
          snapshot = await reader.read();
        } finally {
          hook.mockRestore();
        }
        expect(mutations).toBe(1);
        expect(snapshot).toMatchObject({
          kind: "retained",
          state: { record: { steps } },
          coverage: { kind: "unavailable" },
        });
        expect(await reader.read()).toMatchObject({
          kind: "retained",
          state: { revision: mode.endsWith("work") ? 2 : 1, record: { steps } },
          coverage: { kind: "unavailable" },
        });
      },
    );
  },
);
