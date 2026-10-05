import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import { closeSkillsWatchers } from "../../skills/runtime/refresh.js";
import { ensureOpenClawAgentDatabaseSchema } from "../../state/openclaw-agent-db-schema.js";
import {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesAsync,
} from "../../state/openclaw-agent-db.js";
import { ensureSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentHarnessV2 } from "../harness/types.js";
import { exerciseQueuedInputRecovery } from "./main-session-recovery-queued-inputs.test-support.js";
import {
  freshNativeRecoveryChanges,
  queuedRecoveryChanges,
} from "./main-session-recovery-queued-native.test-support.js";

const nativeAttempt = vi.hoisted(() => vi.fn<AgentHarnessV2["runAttempt"]>());
afterEach(() => closeSkillsWatchers(true));
// mock-isolation: Replace only model execution; importing the real attempt installs the process-global Codex client disposer.
vi.mock("../../../extensions/codex/src/app-server/run-attempt.js", () => ({
  runCodexAppServerAttempt: nativeAttempt,
}));

it.each(queuedRecoveryChanges)(
  "preserves accepted queued issuer FIFO, once and currentness after reopen: %s",
  (change) => exerciseQueuedInputRecovery(change, nativeAttempt),
  120_000,
);

it.each(freshNativeRecoveryChanges)(
  "recovers fresh original-issuer native turns with current profile binding: %s",
  (change) => exerciseQueuedInputRecovery(change, nativeAttempt),
  120_000,
);

it.each(["open", "doctor", "first-use"] as const)(
  "preserves accepted input bytes and schema versions when adding private queued custody through %s",
  async (path) => {
    const column = "recovery_intent_json";
    await withOpenClawTestState({ label: "pending-input-column" }, async (state) => {
      const options = {
        agentId: "main",
        env: state.env,
      };
      const scope = { ...options, sessionKey: "agent:main:column", sessionId: "column-session" };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const receipt = await stageSessionPendingInput(scope, {
        runId: "column-run",
        message: {
          role: "user",
          content: "Retain exact input",
          timestamp: 1,
          idempotencyKey: "column-run:user",
        },
        assertCurrent: () => {},
      });
      receipt!.finish("interrupted");
      await receipt!.settled?.();
      const filename = openOpenClawAgentDatabase(options).path;
      await closeOpenClawAgentDatabasesAsync();
      const old = new DatabaseSync(filename);
      old.exec(`ALTER TABLE session_pending_inputs DROP COLUMN ${column}`);
      const version = old.prepare("PRAGMA user_version").get();
      const metadata = old.prepare("SELECT * FROM schema_meta").all();
      const original = old.prepare("SELECT message_json FROM session_pending_inputs").get();
      old.close();
      expect(await listSessionPendingInputs(scope)).toMatchObject({
        total: 1,
        items: [{ state: "interrupted", message: receipt!.message }],
      });
      if (path === "open") {
        openOpenClawAgentDatabase(options);
        await closeOpenClawAgentDatabasesAsync();
      } else {
        const current = new DatabaseSync(filename);
        if (path === "doctor") {
          ensureOpenClawAgentDatabaseSchema(current, options);
        } else {
          ensureSessionPendingInputsSchema(current);
        }
        current.close();
      }
      const reopened = new DatabaseSync(filename, { readOnly: true });
      try {
        expect(reopened.prepare("PRAGMA user_version").get()).toEqual(version);
        expect(reopened.prepare("SELECT * FROM schema_meta").all()).toEqual(metadata);
        expect(reopened.prepare("SELECT message_json FROM session_pending_inputs").get()).toEqual(
          original,
        );
        expect(reopened.prepare(`SELECT ${column} FROM session_pending_inputs`).get()).toEqual({
          [column]: null,
        });
      } finally {
        reopened.close();
      }
    });
  },
);
