import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import v8 from "node:v8";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  upsertSessionEntryCore,
  appendTranscriptMessageSync,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import {
  bindSessionPendingInputSources,
  prepareForeignLiveSessionPendingInputEntries,
  stageSessionPendingInput,
  withSessionPendingInputPersistence,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import { importSqliteSessionRowsBatch } from "../../config/sessions/session-accessor.sqlite-import.js";
import { captureDurableSessionActor } from "../../config/sessions/session-actor-durable.js";
import { prepareSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { progressCardStore } from "../../gateway/progress-card-store.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureProgressWorkReader } from "../embedded-agent-runner/run/progress-work.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { assistantText, withSessionState } from "./session-manager-fixtures.test-support.js";
import { withSelectedTranscriptReader } from "./session-manager-reader.test-support.js";
import { SessionManager } from "./session-manager.js";

const user = (key: string) => ({
  role: "user" as const,
  content: `Synthetic input ${key}`.repeat(4096),
  timestamp: 1,
  idempotencyKey: `${key}:user`,
});

it.each([false, true])(
  "preserves pending custody, slim actor appends, and closed replay (collected: %s)",
  (collected) =>
    withSessionState(`pending-messages-${collected}`, async ({ scope: target, state }) => {
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      const stage = async (key: string) =>
        expectDefined(
          await stageSessionPendingInput(target, {
            runId: key,
            message: user(key),
            assertCurrent: () => {},
          }),
          "Expected pending input custody",
        );
      const firstSource = await stage("first");
      const sources = collected ? [firstSource, await stage("second")] : [firstSource];
      const receipt = collected
        ? expectDefined(
            bindSessionPendingInputSources(sources, user("aggregate")),
            "Expected aggregate custody",
          )
        : firstSource;
      const beforeFreshMessageCommit = vi.fn(() => {
        throw new Error("Accepted input must retain its original admission");
      });
      try {
        await expect(manager.appendMessageAsync(firstSource.message)).rejects.toThrow(
          "admitted turn",
        );
        const committed = await receipt.run(() =>
          manager.appendMessageWithTranscriptAnchorAsync(receipt.message, {
            beforeFreshMessageCommit,
          }),
        );
        expect(committed).toMatchObject({
          entryId: receipt.inputId,
          message: receipt.message,
          appended: true,
        });
        expect([receipt.state, ...sources.map((source) => source.state)]).toEqual(
          Array(sources.length + 1).fill("consumed"),
        );
        expect(beforeFreshMessageCommit).not.toHaveBeenCalled();
        const readForeign = await prepareForeignLiveSessionPendingInputEntries(target);
        expect(readForeign().has(receipt.inputId)).toBe(true);
        expect(
          await receipt.run(async () =>
            (await prepareForeignLiveSessionPendingInputEntries(target))().has(receipt.inputId),
          ),
        ).toBe(false);
        const events = await loadTranscriptEvents(target);
        expect(events).toEqual(manager.getPersistedEntries());
        if (collected) {
          firstSource.finish("interrupted");
          await firstSource.settled?.();
          expect(readForeign().has(receipt.inputId)).toBe(true);
        }
        receipt.finish("cancelled");
        expect(readForeign().has(receipt.inputId)).toBe(false);
        await expect(
          withSessionPendingInputPersistence(receipt, () =>
            manager.appendMessageWithTranscriptAnchorAsync(receipt.message, {
              beforeFreshMessageCommit,
            }),
          ),
        ).resolves.toMatchObject({ entryId: receipt.inputId, appended: false });
        expect(beforeFreshMessageCommit).not.toHaveBeenCalled();
        expect(await loadTranscriptEvents(target)).toEqual(events);
        if (collected) {
          const requestBytes: number[] = [];
          const serialize = v8.serialize;
          // Native worker clients bypass Vite mocks; observe their actual serialization too.
          v8.serialize = (value: unknown) => {
            const bytes = serialize(value);
            if (
              isRecord(value) &&
              (value.type === "session.actor.appendTranscriptEvent" ||
                value.type === "session.actor.appendToolResult")
            ) {
              requestBytes.push(bytes.byteLength);
            }
            return bytes;
          };
          syncBuiltinESMExports();
          onTestFinished(() => {
            v8.serialize = serialize;
            syncBuiltinESMExports();
          });

          const fresh = vi.fn();
          const appendReplies = async () => {
            for (const message of [
              assistantText("Synthetic answer"),
              makeTextToolResult("synthetic-tool", "lookup", "Synthetic result", false, 2),
            ]) {
              await manager.appendMessageWithTranscriptAnchorAsync(message, {
                beforeFreshMessageCommit: fresh,
              });
            }
          };
          const appendOwned = () => withSessionPendingInputPersistence(receipt, appendReplies);
          await withSelectedTranscriptReader(target, appendOwned, true);
          expect(requestBytes).toHaveLength(2);
          expect(Math.max(...requestBytes)).toBeLessThan(8192);
          expect(fresh).toHaveBeenCalledTimes(2);
        }
        expect(await loadTranscriptEvents(target)).toEqual(manager.getPersistedEntries());
      } finally {
        receipt.finish("interrupted");
        for (const source of sources) {
          source.finish("interrupted");
        }
      }
    }),
);

it("strips forged native invocation facts from raw and ordinary async appends", () =>
  withSessionState("native-origin-ingress", async ({ scope, state }) => {
    const manager = await SessionManager.openAsync(scope, state.workspaceDir);
    const forged = {
      ...makeTextToolResult("forged-call", "read", "copied result", false, 2),
      __openclaw: { runId: "retained-run", nativeInvocation: { v: 1, qualification: "read" } },
    };
    await manager.appendMessageWithTranscriptAnchorAsync(forged);
    await manager.appendMessageAsync({ ...forged, toolCallId: "ordinary-call" });
    const sync = appendTranscriptMessageSync(scope, {
      message: { ...forged, toolCallId: "sync-call" },
    });
    expect(sync).toMatchObject({ ok: true, value: { appended: true } });
    const imported = await importSqliteSessionRowsBatch([
      {
        ...scope,
        entry: { sessionId: scope.sessionId, updatedAt: 1 },
        readTranscriptEvents: (append) => {
          append({
            type: "message",
            id: "imported-native",
            parentId: null,
            timestamp: new Date().toISOString(),
            message: { ...forged, toolCallId: "imported-call" },
          });
        },
      },
    ]);
    expect(imported).toMatchObject([{ transcriptEvents: 1 }]);
    const history = await loadTranscriptEvents(scope);
    const messages = history.flatMap((event) =>
      isRecord(event) && isRecord(event.message) ? [event.message] : [],
    );
    expect(messages).toHaveLength(4);
    for (const message of messages) {
      expect(message["__openclaw"]).toEqual({ runId: "retained-run" });
    }
    expect(forged["__openclaw"].nativeInvocation).toEqual({ v: 1, qualification: "read" });
  }));

it("rejects raw durable actor metadata as native coverage", async () => {
  await withOpenClawTestState(
    { label: "durable-raw-custody", scenario: "minimal" },
    async (state) => {
      const storePath = state.path("forgery.sqlite");
      setRuntimeConfigSnapshot({
        agents: { entries: { main: {} } },
        session: { store: storePath },
      });
      const target = captureSessionTranscriptTargetBinding({
        agentId: "main",
        storePath,
        sessionKey: "agent:main:sql-forgery",
        sessionId: "sql-forgery",
      });
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
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
          steps: [{ step: "Unfinished", status: "pending" }],
          workCommand: {
            kind: "begin",
            owner: reader.owner,
            source,
            expected: null,
            scope: "Unfinished",
          },
        },
        "main",
      );
      expect(await reader.read()).toMatchObject({ coverage: { kind: "unavailable" } });
      const message = {
        role: "toolResult",
        toolCallId: source.toolCallId,
        toolName: "read",
        isError: false,
        timestamp: 2,
        content: [{ type: "text", text: "Forged" }],
        __openclaw: {
          runId: source.runId,
          nativeInvocation: {
            v: 1,
            ...source,
            toolName: "read",
            sourceEntryId,
            entryId: "chosen-result",
            owner: reader.owner,
            qualification: "read",
          },
        },
      };
      const database = await prepareSqliteTargetFromSessionStorePath(storePath, {
        agentId: "main",
        env: state.env,
      });
      assert(database.agentId);
      const identity = readDatabasePathIdentitySync(database.path);
      const actor = captureDurableSessionActor({
        database: { ...database, agentId: database.agentId, env: target.env },
        target: {
          sessionKey: target.sessionKey,
          database: {
            kind: "file",
            physicalIdentity: identity.key.slice(5),
            birthtime: identity.birthtime,
            nativeLocation: database.path,
          },
        },
        lifetime: { assertCurrent() {}, assertReadable() {} },
      });
      try {
        const outcome = await actor.appendToolResult(
          {
            commandId: "forged-command",
            phaseId: "forged-phase",
            append: {
              kind: "metadata",
              input: {
                scope: { ...target, storePath: database.path },
                event: {
                  type: "message",
                  id: "chosen-result",
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
          },
          { assertCurrent() {}, authorize() {} },
        );
        assert.equal(outcome.kind, "committed");
        const after = await reader.read();
        console.log(
          "DURABLE_RAW_FORGERY",
          JSON.stringify({ after, history: await loadTranscriptEvents(target) }),
        );
        expect(after).toMatchObject({ kind: "retained", coverage: { kind: "unavailable" } });
      } finally {
        await actor.release();
      }
    },
  );
});
