import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  prepareSqliteReadOnlyLocation,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { z } from "zod";
import { readCodexNativeSubagentRunId } from "../app-server/native-subagent-assignment.js";
import {
  codexNativeSubagentHistoryConnectionFingerprint,
  readCodexNativeSubagentHistoryOwner,
} from "../app-server/native-subagent-history-owner.js";
import {
  readNativePendingAssignments,
  type CodexNativeSubagentPendingAssignment,
} from "../app-server/native-subagent-pending-assignments.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
} from "../app-server/session-binding-meta.js";
import {
  bindingStoreKey,
  readStoredCodexAppServerBinding,
  type StoredCodexAppServerBinding,
} from "../app-server/session-binding-record.js";

type Params = Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0];
type LegacyTask = {
  task_id: string;
  runtime: string;
  task_kind: string | null;
  run_id: string | null;
  agent_id: string | null;
  requester_session_key: string | null;
  owner_key: string;
  scope_kind: string;
  status: string;
  delivery_status: string;
  ended_at: number | null;
  terminal_summary: string | null;
  detail_json: string | null;
};
type LegacyDatabase = {
  task_runs: LegacyTask;
  plugin_state_entries: {
    plugin_id: string;
    namespace: string;
    entry_key: string;
    value_json: string;
    expires_at: number | null;
  };
};
const importSchema = z
  .object({ version: z.literal(1), taskIds: z.array(z.string().min(1)) })
  .strict();
const detailSchema = z.object({ nativeTurnId: z.string().trim().min(1).optional() });

function databasePath(params: Pick<Params, "stateDir">) {
  return path.join(params.stateDir, "state", "openclaw.sqlite");
}

const missingOwnerMessage =
  "missing original requester session, lifecycle and connection facts (nativeHistory); inspect the original child in its native Codex account, or restore the pre-upgrade backup with its matching OpenClaw version to finish delivery";

function taskIdentity(task: LegacyTask) {
  try {
    const owner = readCodexNativeSubagentHistoryOwner(
      task.detail_json ? JSON.parse(task.detail_json) : {},
    );
    return task.agent_id && task.requester_session_key && owner
      ? {
          kind: "session" as const,
          agentId: task.agent_id,
          sessionKey: task.requester_session_key,
          sessionId: owner.sessionId,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function inspect(params: Params) {
  const source = databasePath(params);
  try {
    await fs.access(source);
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
  const snapshot = await prepareSqliteReadOnlyLocation(source, { preserveSourceArtifacts: true });
  try {
    const db = openNodeSqliteDatabase(snapshot.location, { readOnly: true });
    try {
      if (!tableExists(db, "task_runs") || !tableExists(db, "plugin_state_entries")) {
        return [];
      }
      const sql = getNodeSqliteKysely<LegacyDatabase>(db);
      const rows = executeSqliteQuerySync(
        db,
        sql
          .selectFrom("task_runs")
          .select([
            "task_id",
            "runtime",
            "task_kind",
            "run_id",
            "agent_id",
            "requester_session_key",
            "owner_key",
            "scope_kind",
            "status",
            "delivery_status",
            "ended_at",
            "terminal_summary",
            "detail_json",
          ])
          .select((eb) =>
            eb
              .selectFrom("task_runs as all_runs")
              .select((count) => count.fn.countAll<number>().as("count"))
              .whereRef("all_runs.run_id", "=", "task_runs.run_id")
              .where("all_runs.runtime", "=", "subagent")
              .where("all_runs.task_kind", "=", "codex-native")
              .as("run_count"),
          )
          .where("runtime", "=", "subagent")
          .where("task_kind", "=", "codex-native")
          .where("delivery_status", "!=", "delivered")
          .where((eb) =>
            eb.or([
              eb("status", "in", ["queued", "running"]),
              eb("delivery_status", "=", "pending"),
              eb.and([
                eb("delivery_status", "=", "not_applicable"),
                eb("ended_at", ">=", Date.now() - 60_000),
              ]),
            ]),
          ),
      ).rows;
      return rows.filter((row) => {
        const identity = taskIdentity(row);
        if (!identity) {
          return true;
        }
        const binding = executeSqliteQuerySync(
          db,
          sql
            .selectFrom("plugin_state_entries")
            .select("value_json")
            .where("plugin_id", "=", "codex")
            .where("namespace", "=", CODEX_APP_SERVER_BINDING_NAMESPACE)
            .where("entry_key", "=", bindingStoreKey(identity))
            .where((eb) =>
              eb.or([eb("expires_at", "is", null), eb("expires_at", ">", Date.now())]),
            ),
        ).rows[0];
        try {
          const stored = binding && readStoredCodexAppServerBinding(JSON.parse(binding.value_json));
          const imported = importSchema.safeParse(stored?.nativeSubagentTaskImport);
          return !imported.success || !imported.data.taskIds.includes(row.task_id);
        } catch {
          return true;
        }
      });
    } finally {
      db.close();
    }
  } finally {
    await snapshot.cleanupAsync();
  }
}

function prepareAssignment(task: LegacyTask, stored: StoredCodexAppServerBinding, params: Params) {
  const identity = taskIdentity(task);
  const native = readCodexNativeSubagentRunId(task.run_id ?? undefined);
  const detail: unknown = task.detail_json ? JSON.parse(task.detail_json) : {};
  const owner = readCodexNativeSubagentHistoryOwner(detail);
  if (!owner) {
    throw new Error(missingOwnerMessage);
  }
  if (
    !identity ||
    !native ||
    !task.run_id ||
    stored.state !== "active" ||
    stored.binding.pendingSupervisionBranch
  ) {
    throw new Error(
      "current requester binding is unavailable; reconnect the original requester and run openclaw doctor --fix",
    );
  }
  const session = getSessionEntry({
    agentId: identity.agentId,
    sessionKey: identity.sessionKey,
    env: params.env,
    storePath: resolveStorePath(params.config.session?.store, {
      agentId: identity.agentId,
      env: params.env,
    }),
    readConsistency: "latest",
  });
  if (
    !session ||
    session.sessionId !== owner.sessionId ||
    stored.sessionId !== owner.sessionId ||
    session.lifecycleRevision !== owner.lifecycleRevision ||
    (session.agentHarnessId !== undefined && session.agentHarnessId !== "codex") ||
    codexNativeSubagentHistoryConnectionFingerprint(stored.binding) !== owner.connectionFingerprint
  ) {
    throw new Error(
      "requester session, lifecycle, or connection ownership no longer matches; inspect the original child in its native Codex account",
    );
  }
  if (task.scope_kind !== "session" || task.owner_key !== identity.sessionKey) {
    throw new Error(
      "Task requester ownership does not match its session; inspect the original child in its native Codex account",
    );
  }
  const nativeTurnId = detailSchema.parse(detail).nativeTurnId ?? native.turnId;
  const assignment: CodexNativeSubagentPendingAssignment = {
    runId: task.run_id,
    childThreadId: native.threadId,
    ...(nativeTurnId ? { nativeTurnId } : {}),
    nativeParentThreadId: owner.parentThreadId,
    owner,
    ...((task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") &&
    task.terminal_summary
      ? {
          recordedCompletion: {
            childThreadId: native.threadId,
            status: task.status,
            statusLabel: "recorded_task_result" as const,
            result: task.terminal_summary,
            ...(task.ended_at !== null ? { completedAt: task.ended_at } : {}),
          },
        }
      : {}),
  };
  return assignment;
}

export const codexNativeTaskAssignmentMigration = {
  id: "codex-native-task-assignments",
  label: "Codex native pending assignments",
  collectBackupResources: (params) => [{ path: databasePath(params), kind: "sqlite" }],
  async detectLegacyState(params) {
    return (await inspect(params)).length > 0
      ? { preview: ["- Preserve native Codex child recovery before retiring Tasks"] }
      : null;
  },
  async migrateLegacyState(params) {
    const rows = await inspect(params);
    const warnings: string[] = [];
    if (rows.length === 0) {
      return { changes: [], warnings };
    }
    let imported = 0;
    const store = params.context.openPluginStateKeyedStore<StoredCodexAppServerBinding>({
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      env: params.env,
    });
    for (const task of rows) {
      try {
        const identity = taskIdentity(task);
        if (!identity) {
          throw new Error(missingOwnerMessage);
        }
        if (!store.observe || !store.compareAndApply || !store.withCurrent) {
          throw new Error(
            "current requester identity or atomic binding storage is unavailable; run openclaw doctor --fix with the current version",
          );
        }
        if (task.run_count !== 1) {
          throw new Error(
            "duplicate native assignment identity; inspect the retained Task records before repairing them",
          );
        }
        const key = bindingStoreKey(identity);
        const observed = await store.observe(key);
        const stored = readStoredCodexAppServerBinding(observed.value);
        if (!stored) {
          throw new Error(
            "original requester binding is unavailable; inspect the child in its native Codex account",
          );
        }
        const marker =
          stored.nativeSubagentTaskImport === undefined
            ? { version: 1 as const, taskIds: [] }
            : importSchema.parse(stored.nativeSubagentTaskImport);
        if (marker.taskIds.includes(task.task_id)) {
          continue;
        }
        const assignment = prepareAssignment(task, stored, params);
        if (stored.state !== "active" || observed.value?.state !== "active") {
          continue;
        }
        const assignments =
          readNativePendingAssignments(stored.nativeSubagentAssignments)?.assignments ?? [];
        const existing = assignments.find((value) => value.runId === assignment.runId);
        if (existing && !isDeepStrictEqual(existing, assignment)) {
          throw new Error(
            "a newer binding assignment already owns this result; preserve both records for inspection",
          );
        }
        const next: StoredCodexAppServerBinding = {
          ...stored,
          ...observed.value,
          nativeSubagentAssignments: {
            version: 1,
            assignments: existing ? assignments : [...assignments, assignment],
          },
          nativeSubagentTaskImport: { version: 1, taskIds: [...marker.taskIds, task.task_id] },
        };
        // The import marker and recovery payload share one compare-and-apply commit.
        const writer = store.withCurrent({
          assertCurrent: () => {
            prepareAssignment(task, stored, params);
          },
        });
        const result = await writer.compareAndApply(key, observed.comparison, {
          operation: "update",
          action: "set",
          value: next,
        });
        if (result.status === "conflict") {
          throw new Error("binding changed during import; run openclaw doctor --fix again");
        }
        imported += 1;
      } catch (error) {
        warnings.push(
          `Native Codex task ${task.task_id} (${task.run_id ?? "unknown child"}) was preserved without migration: ${String(error)}`,
        );
      }
    }
    return {
      changes: imported
        ? [`Preserved ${imported} native Codex assignment(s) in their existing parent bindings`]
        : [],
      warnings,
      ...(warnings.length ? { warningDisposition: "recoverable" as const } : {}),
    };
  },
} satisfies PluginDoctorStateMigration;
