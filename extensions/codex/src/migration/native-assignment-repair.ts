import { setImmediate as nextTurn } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { codexNativeSubagentRunId } from "../app-server/native-subagent-assignment.js";
import { codexNativeSubagentHistoryConnectionFingerprint } from "../app-server/native-subagent-history-owner.js";
import { normalizeNativePendingAssignments } from "../app-server/native-subagent-pending-assignments.js";
import { readCodexNativeSubagentSubmissions } from "../app-server/native-subagent-submission.js";
import { CODEX_APP_SERVER_BINDING_NAMESPACE } from "../app-server/session-binding-meta.js";
import { readStoredCodexAppServerBinding } from "../app-server/session-binding-record-codec.js";

const loadSessionStoreRuntime = createLazyRuntimeModule(async () => {
  const { getSessionEntryByIdAsync, resolveStorePath } =
    await import("openclaw/plugin-sdk/session-store-runtime");
  return { getSessionEntryByIdAsync, resolveStorePath };
});
const loadSessionBindingRecord = createLazyRuntimeModule(
  () => import("../app-server/session-binding-record.js"),
);

type Params = Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0];
type BindingRow = ReturnType<
  NonNullable<PluginDoctorStateMigrationContext["readPluginStateEntriesInKeyRange"]>
>[number];

type IdentityEvidence = Awaited<
  ReturnType<NonNullable<PluginDoctorStateMigrationContext["readSessionIdentityEvidenceBatch"]>>
>[number];

function prepareRow(entry: BindingRow, warnings: string[]) {
  const raw = asOptionalRecord(entry.value);
  if (raw?.nativeSubagentAssignments === undefined) {
    return undefined;
  }
  const stored = readStoredCodexAppServerBinding(raw);
  if (!stored) {
    warnings.push(
      `Preserved Codex native assignments in ${entry.key}; the binding could not be decoded. Inspect it before retrying Doctor.`,
    );
    return undefined;
  }
  if (stored.state !== "active") {
    return undefined;
  }
  let inventory;
  try {
    inventory = normalizeNativePendingAssignments(raw.nativeSubagentAssignments);
  } catch {
    warnings.push(
      `Preserved malformed Codex native assignments in ${entry.key}; inspect the binding before retrying Doctor.`,
    );
    return undefined;
  }
  const assignments = inventory?.assignments ?? [];
  const identity = /^(session-key|session):([a-z0-9][a-z0-9_-]{0,63}):(.+)$/u.exec(entry.key);
  const binding = asOptionalRecord(raw.binding);
  const fingerprint = codexNativeSubagentHistoryConnectionFingerprint(stored.binding);
  const requester =
    assignments.length > 0 &&
    identity &&
    stored.sessionId &&
    binding &&
    raw.retired === undefined &&
    (identity[1] === "session-key"
      ? /^[A-Za-z0-9_-]{43}$/u.test(identity[3]!)
      : identity[3] === stored.sessionId) &&
    binding.connectionScope === undefined &&
    binding.supervisionSourceThreadId === undefined &&
    binding.pendingSupervisionBranch === undefined &&
    (binding.authProfileId === undefined || typeof binding.authProfileId === "string") &&
    fingerprint
      ? { agentId: identity[2]!, sessionId: stored.sessionId, kind: identity[1], fingerprint }
      : undefined;
  return { entry, raw, assignments, requester };
}

async function normalizeRow(
  row: NonNullable<ReturnType<typeof prepareRow>>,
  params: Params,
  warnings: string[],
  evidence?: IdentityEvidence,
) {
  const { entry, raw, requester } = row;
  let assignments = row.assignments;
  const originalAssignments = assignments;
  if (requester && params.context.readSessionIdentityEvidenceBatch) {
    try {
      const { agentId, sessionId, fingerprint } = requester;
      if (!evidence) {
        throw new Error("Requester ownership is unresolved");
      }
      if (evidence.state === "absent") {
        assignments = [];
      } else if (evidence.state === "current") {
        const { getSessionEntryByIdAsync, resolveStorePath } = await loadSessionStoreRuntime();
        const { bindingStoreKey } = await loadSessionBindingRecord();
        const current = await getSessionEntryByIdAsync({
          agentId,
          sessionId,
          env: params.env,
          storePath: resolveStorePath(params.config.session?.store, { agentId, env: params.env }),
          readConsistency: "latest",
        });
        if (
          !current ||
          current.entry.sessionId !== sessionId ||
          current.sessionKey !== evidence.sessionKey
        ) {
          throw new Error("Requester ownership is unresolved");
        }
        const currentKey = bindingStoreKey({
          kind: "session",
          agentId,
          sessionId: current.entry.sessionId,
          ...(requester.kind === "session-key" ? { sessionKey: current.sessionKey } : {}),
        });
        let unknownLifecycle = false;
        assignments = assignments.filter((assignment) => {
          if (
            currentKey !== entry.key ||
            assignment.owner.sessionId !== current.entry.sessionId ||
            assignment.owner.connectionFingerprint !== fingerprint
          ) {
            return false;
          }
          if (!assignment.owner.lifecycleRevision || !current.entry.lifecycleRevision) {
            unknownLifecycle = true;
            return true;
          }
          return assignment.owner.lifecycleRevision === current.entry.lifecycleRevision;
        });
        if (unknownLifecycle) {
          warnings.push(
            `Preserved Codex assignments with unknown lifecycle evidence in ${entry.key}.`,
          );
        }
      } else {
        warnings.push(
          `Preserved Codex assignments with unknown requester evidence in ${entry.key}.`,
        );
      }
    } catch {
      warnings.push(
        `Could not establish requester ownership for Codex native assignments in ${entry.key}; preserved them for a later Doctor repair.`,
      );
    }
  } else if (assignments.length > 0) {
    warnings.push(
      `Preserved Codex native assignments in ${entry.key}; ownership inspection prerequisites are incomplete. Inspect the binding before retrying Doctor.`,
    );
  }
  const next = assignments.length ? { version: 1, assignments } : undefined;
  if (isDeepStrictEqual(next, raw.nativeSubagentAssignments)) {
    return undefined;
  }
  const { nativeSubagentAssignments: _previous, ...value } = raw;
  const retired = originalAssignments.filter((assignment) => !assignments.includes(assignment));
  if (retired.length) {
    try {
      const submissions = readCodexNativeSubagentSubmissions(raw.nativeSubagentSubmissions);
      if (submissions) {
        const receipts = submissions.receipts.filter(
          (receipt) =>
            !retired.some(
              (assignment) =>
                isDeepStrictEqual(submissions.owner, assignment.owner) &&
                submissions.owner.parentThreadId === assignment.nativeParentThreadId &&
                receipt.childThreadId === assignment.childThreadId &&
                (receipt.submissionId === assignment.nativeTurnId ||
                  codexNativeSubagentRunId(receipt.childThreadId, receipt.submissionId) ===
                    assignment.runId) &&
                (!assignment.submission || isDeepStrictEqual(receipt, assignment.submission)),
            ),
        );
        if (receipts.length !== submissions.receipts.length) {
          delete value.nativeSubagentSubmissions;
          if (receipts.length) {
            value.nativeSubagentSubmissions = { ...submissions, receipts };
          }
        }
      }
    } catch {
      warnings.push(
        `Preserved uncertain native submission receipts in ${entry.key}; inspect them before retrying Doctor.`,
      );
    }
  }
  return { entry, value: { ...value, ...(next ? { nativeSubagentAssignments: next } : {}) } };
}

async function* inspect(params: Params) {
  const read = params.context.readPluginStateEntriesInKeyRange;
  if (!read) {
    return;
  }
  let after: string | undefined;
  while (true) {
    const rows = read(CODEX_APP_SERVER_BINDING_NAMESPACE, { prefix: "", after, limit: 512 });
    const replacements = [];
    const warnings: string[] = [];
    const prepared = rows.flatMap((entry) => {
      const row = prepareRow(entry, warnings);
      return row ? [row] : [];
    });
    const requested = prepared.flatMap(({ requester }) =>
      requester ? [{ agentId: requester.agentId, sessionId: requester.sessionId }] : [],
    );
    let evidence: IdentityEvidence[] = [];
    if (requested.length && params.context.readSessionIdentityEvidenceBatch) {
      try {
        // The host verifies each legacy source once within this bounded page.
        evidence = await params.context.readSessionIdentityEvidenceBatch(requested);
      } catch {
        // Missing evidence preserves every affected row with its existing warning.
      }
    }
    let evidenceIndex = 0;
    for (const row of prepared) {
      const observed = row.requester ? evidence[evidenceIndex++] : undefined;
      const replacement = await normalizeRow(row, params, warnings, observed);
      if (replacement) {
        replacements.push(replacement);
      }
    }
    if (replacements.length || warnings.length) {
      yield { replacements, warnings };
    }
    if (rows.length < 512) {
      return;
    }
    after = rows.at(-1)?.key;
    // Synchronous evidence reads and settled promises must still admit timers and owner messages.
    await nextTurn();
  }
}

export const codexNativeAssignmentRepair: PluginDoctorStateMigration = {
  id: "codex-native-assignment-repair",
  label: "Codex native pending assignment repair",
  doctorOnly: true,
  phase: "after-session-repair",
  collectBackupResources: () => [],
  async detectLegacyState(params) {
    for await (const _ of inspect(params)) {
      return { preview: ["- Repair duplicate or obsolete Codex native pending assignments"] };
    }
    return null;
  },
  async migrateLegacyState(params) {
    const changes: string[] = [];
    const warnings: string[] = [];
    const repair = params.context.repairPluginStateEntries;
    if (!repair) {
      return {
        changes,
        warnings: ["Codex native assignment repair requires locked SQLite maintenance ownership"],
        warningDisposition: "recoverable",
      };
    }
    for await (const inspected of inspect(params)) {
      warnings.push(...inspected.warnings);
      if (!inspected.replacements.length) {
        continue;
      }
      try {
        const result = await repair(CODEX_APP_SERVER_BINDING_NAMESPACE, inspected.replacements);
        changes.push(
          ...result.changes,
          `Repaired native pending assignments in ${inspected.replacements.length} Codex binding(s)`,
        );
        warnings.push(...result.warnings);
      } catch {
        warnings.push(
          "Codex native assignment bindings could not be repaired; preserved them for a later openclaw doctor --fix pass.",
        );
      }
    }
    return {
      changes,
      warnings,
      ...(warnings.length ? { warningDisposition: "recoverable" as const } : {}),
    };
  },
};
