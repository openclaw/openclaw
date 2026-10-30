#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { format } from "oxfmt";
import * as ts from "typescript/ast";
import { inspectDatabaseWorkerBoundaries } from "./lib/database-worker-compat.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  createNativeTypeScriptParser,
  reportNativeTypeScriptPhase,
} from "./lib/native-typescript.mts";
import { loadRatchetSources } from "./lib/shrink-ratchet.mts";

const defaultRoot = path.resolve(import.meta.dirname, "..");
const outputPath = "docs/reference/database-schemas/worker-access-inventory.md";
const primitives = new Map([
  ["executeSqliteQuerySync", "Q"],
  ["executeSqliteQueryTakeFirstSync", "F"],
  ["runOpenClawStateWriteTransaction", "S"],
  ["runOpenClawAgentWriteTransaction", "A"],
  ["withOpenClawAgentDatabaseReadOnly", "R"],
]);
const excluded =
  /(?:^|\/)(?:__tests__|__fixtures__|test|tests|test-utils|test-helpers|test-support|test-fixtures|test-harness|fixtures|e2e)(?:\/|$)|(?:^|[/.-])(?:test|spec|e2e|test-support|test-helpers|test-fixtures|test-harness|test-runtime)(?:[.-])/;
const testSuites = new Set([
  // Imports Vitest; only server.auth.default-token.test.ts imports this suite.
  "src/gateway/server.auth.default-token.suite.ts",
]);
const reviewed = new Map([
  [
    "src/infra/client-credential-store.ts",
    {
      tier: "T3",
      evidence:
        "Runtime operations enter through client-credential.worker.ts. Synchronous access is limited to Doctor credential/exec-policy migration, verified archive restore, and device-identity-store.ts offline CLI/Doctor adapters; runtime identity and token callers await client-credential-async.ts.",
    },
  ],
  [
    "src/infra/client-credential-legacy.ts",
    {
      tier: "T3",
      evidence:
        "Only state-migrations.device-identity.ts and state-migrations.device-auth.ts call the consumed-claim importer under Doctor migration custody.",
    },
  ],
  [
    "src/infra/client-credential-operations.ts",
    {
      tier: "T3",
      evidence:
        "Only client-credential-store.ts dispatches these local operations. Runtime identity/token/socket callers use client-credential-async.ts and client-credential.worker.ts; native calls are offline Doctor/CLI identity, legacy exec-policy migration, or verified archive restore.",
    },
  ],
  [
    "src/infra/client-credential-readiness.ts",
    {
      tier: "T3",
      evidence:
        "Receipt admission runs in client-credential.worker.ts for runtime operations and in the offline local owner for Doctor/CLI. Other receipt writers are canonical/legacy credential migration and verified archive relocation; no Gateway main-thread runtime caller.",
    },
  ],
  [
    "src/daemon/runtime-pin-store.ts",
    { tier: "T3", evidence: "CLI service owner / Doctor migration; no Gateway runtime." },
  ],
  [
    "src/daemon/runtime-pin-state.ts",
    { tier: "T3", evidence: "CLI service locks; CLI status and Doctor audits; no Gateway caller." },
  ],
  [
    "src/infra/state-migrations.daemon-runtime-pins.ts",
    { tier: "T3", evidence: "Doctor config-machine-state / pin fence; exclusive migration lock." },
  ],
  [
    "src/config/sessions/goals-operations.ts",
    {
      priority: 99,
      evidence:
        "goals-management.ts dispatches session.goal.mutate to its worker. Receipt kernels also serve session-turn.kernel.ts and sqlite-transcript-turn.ts: session-turn.ts retains native execution for opaque or foreign-store source authority, including Gateway goal chat. These shared receipt operations remain mixed.",
    },
  ],
  [
    "src/infra/outbound/current-conversation-bindings.ts",
    {
      priority: 99,
      evidence:
        "Bundled mutations use awaited worker methods; final-effect binding inspection remains synchronous. Synchronous update/list/delete remain reachable through v2026.10.2's account manager and SessionBindingService SDK methods. The shared V1/V2 manager factory returns both method sets, so these escaped receivers remain conservative T1, not proven T1-compat or worker-only.",
    },
  ],
  [
    "src/agents/github-oauth-records.native.ts",
    {
      priority: 99,
      evidence:
        "Deprecated Gateway SDK cancelAuthorization/retireProfile methods only; bundled callers await the Async replacements. Native completion is preserved until removal after stable deprecation.",
    },
  ],
  [
    "src/secrets/store/secret-store-hidden-github.kernel.ts",
    {
      priority: 99,
      evidence:
        "Shared SQL kernel for worker-owned GitHub records and deprecated synchronous managed/personal Gateway SDK methods. Native compatibility calls remain explicit T1 debt.",
    },
  ],
  [
    "src/state/user-profiles.ts",
    { priority: 1, evidence: "Profile creation; write-coordination cutover owned separately" },
  ],
  [
    "src/infra/exec-approvals-sqlite.ts",
    {
      priority: 1,
      evidence:
        "Bundled execution guards consume committed policy receipts; deprecated synchronous SDK readers and native approval compatibility retain shared row kernels",
    },
  ],
  [
    "src/infra/exec-approvals-store.ts",
    {
      priority: 1,
      evidence:
        "Runtime policy mutations use the shared-state writer; native update adapter is Doctor-only",
    },
  ],
  [
    "src/infra/update-managed-service-handoff-cancellation.ts",
    {
      tier: "T3",
      evidence:
        "readCancelledUpdateFamily is called only by reclamation.ts prepareCancelledCustodyRepair, reached through the lease store's prepareRepair from the `openclaw update repair` CLI (update-repair-command.ts).",
    },
  ],
  [
    "src/infra/update-managed-service-handoff-database.ts",
    {
      tier: "T2",
      evidence:
        "readManagedHandoffRepairMetadata and initializeLeaseSchema serve the managed update source-custody lease, a cross-process lock primitive.",
    },
  ],
  [
    "src/infra/update-managed-service-handoff-lease.ts",
    {
      tier: "T3",
      evidence:
        "createLeaseStore.admit is called by original-acquisition.ts from update/repair/triage CLI and the generated lease-source helper; retarget runs in HANDOFF_SCRIPT.",
    },
  ],
  [
    "src/infra/update-managed-service-handoff-mutation.ts",
    {
      tier: "T2",
      evidence:
        "createManagedHandoffMutationReader.childAliases implements managed source-custody lock validation; config/write-lock.ts and daemon/service-operation-lock.ts reach it through the lease owner.",
    },
  ],
  [
    "src/infra/update-managed-service-handoff-original-owner.ts",
    {
      tier: "T2",
      evidence:
        "readOriginalUpdateDependents serves cross-process source-custody lease acquisition/release, not ordinary Gateway state access.",
    },
  ],
  [
    "src/infra/update-managed-service-handoff-reclamation.ts",
    {
      tier: "T3",
      evidence:
        "observeManagedHandoffReclamation.readPairs is called only by lease.ts createLeaseStore admission in CLI/generated source helpers.",
    },
  ],
  [
    "src/infra/update-managed-service-handoff-rows.ts",
    {
      tier: "T2",
      evidence:
        "descendants/deleteRow/updateRow/readRetainedSources belong to cross-process managed source-custody locks. config/write-lock.ts and daemon/service-operation-lock.ts use assertSourceUnborrowed before effects; Gateway release settles the same lease.",
    },
  ],
  [
    "src/infra/update-managed-service-handoff-source-inspection.ts",
    {
      tier: "T2",
      evidence:
        "Schema discovery supports only the managed source-custody lock primitive's first admission and repair.",
    },
  ],
  [
    "src/gateway/session-row-projection.ts",
    {
      priority: 2,
      evidence: "Resident list owner; hydration, dirty/archived rows and process-held reads remain",
    },
  ],
  [
    "src/gateway/session-row-projection-materialize.ts",
    {
      priority: 2,
      evidence:
        "Durable session-list row entries and membership; memory actors supply incognito rows",
    },
  ],
  [
    "src/config/sessions/session-accessor.sqlite-entry-read.ts",
    {
      priority: 2,
      evidence:
        "The child-entry reader is worker-owned; other session-entry readers retain native SDK and maintenance callers and require separate operation evidence.",
    },
  ],
  [
    "src/config/sessions/session-accessor.sqlite-history-projection.ts",
    {
      priority: 99,
      evidence:
        "The history builder and boundary-shape query also serve deprecated SDK readSessionTranscriptCatalogTitle through the native page reader. Coordinate reads are classified separately; do not exempt the shared builder.",
    },
  ],
  [
    "src/config/sessions/session-accessor.sqlite-history.ts",
    {
      priority: 99,
      evidence:
        "Archive and instance kernels serve transcript/usage workers plus deprecated SDK loadArchivedSessions, loadMemorySessionMetadata and resolveMemorySessionTargets (shipped in v2026.10.4). Retain native compatibility until the SDK owner removes it.",
    },
  ],
  [
    "src/config/sessions/session-history.ts",
    {
      priority: 99,
      evidence:
        "Durable instance listings use session-transcript.worker.ts; deprecated memory-session SDK readers retain the native implementation. The async facade's incognito branch reaches withOpenClawAgentDatabaseReadOnly, which returns database-missing before SQL for that sentinel.",
    },
  ],
  [
    "src/config/sessions/session-accessor.sqlite-participant-projection.ts",
    {
      priority: 99,
      evidence:
        "prepareSqliteSessionEntryRowDecoder in session-accessor.sqlite-entry-read.ts serves generic entry decoding as well as workers and deprecated resolveMemorySessionTargets. Its native/callback closure is not proven worker-only or deprecated-only; retain T1 for this shared participant kernel.",
    },
  ],
  [
    "src/config/sessions/session-accessor.sqlite-pending-inputs.ts",
    {
      priority: 99,
      evidence:
        "Completion SQL remains reachable through deprecated UserTurnTranscriptRecorder.completeProcessing (shipped in v2026.10.4); bundled completion awaits completeProcessingAsync. Append/read/consume kernels also serve native transcript transactions carrying opaque source authority. Deletion is classified separately.",
    },
  ],
  [
    "src/config/sessions/session-accessor.sqlite-reset-window.ts",
    {
      priority: 99,
      evidence:
        "Boundary/control queries serve workers plus deprecated SessionManager synchronous context reads and readSessionTranscriptCatalogTitle (shipped in v2026.10.4). Worker-only interval, lookup, oversized-message and accounting queries are classified separately.",
    },
  ],
  [
    "src/config/sessions/session-transcript-search.ts",
    {
      priority: 4,
      evidence:
        "Durable search kernels run in the history worker; memory actors supply incognito search",
    },
  ],
  [
    "src/agents/plugin-model-catalog.ts",
    {
      priority: 6,
      evidence: "Persisted catalog reads in prepared model runtime; also Doctor migration",
    },
  ],
  [
    "src/gateway/worker-environments/store.ts",
    { priority: 7, evidence: "Environment access listing and prepared-pool maintenance" },
  ],
  [
    "src/infra/device-pairing-store.ts",
    {
      tier: "T2",
      priority: 99,
      evidence:
        "Runtime uses device-pairing-core.worker.ts and state-read; native snapshots only in device/node-pairing-migration.ts and startup desktop-node migration",
    },
  ],
  [
    "src/config/sessions/session-sharing-store.ts",
    { priority: 7, evidence: "Session-list member reads and membership mutations" },
  ],
  [
    "src/config/sessions/session-sharing-store.kernel.ts",
    {
      priority: 7,
      evidence:
        "Worker readers share listSessionMembersInDatabase with pending-input/source validation. Gateway voice create/relay reaches client-voice-session-write.ts's native-source branch; client-voice-session-source.ts retains foreign-store authority. Membership is an authorization boundary, not worker-only bookkeeping.",
    },
  ],
  [
    "src/config/sessions/session-reaction-store.kernel.ts",
    {
      priority: 99,
      evidence:
        "Reaction SQL runs only through admitted workers; incognito uses memory actor state",
    },
  ],
  [
    "src/config/sessions/session-reaction-store.ts",
    {
      priority: 99,
      evidence: "Worker-admitted durable reactions and memory actor incognito reactions",
    },
  ],
  [
    "src/config/sessions/conversation-registry.ts",
    {
      priority: 99,
      evidence:
        "selectConversationRows is reachable only from resolveCurrentConversationSession, whose only bundled caller is deprecated SDK getConversationSession. Async registry reads use the session actor or session-transcript.worker.ts; session-entry-current-check.ts consumes captureConversationBindingFacts.",
    },
  ],
  [
    "src/config/sessions/session-accessor.sqlite-conversation-read.ts",
    {
      priority: 99,
      evidence:
        "selectConversationRowsFromDatabase serves transcript workers and deprecated SDK getConversationSession, but also session-accessor.sqlite-entry-mutation.ts's resolveConversationInDatabase and readSessionSourceValidation. client-voice-session-source.ts and client-voice-session-write.ts still invoke that validator natively for opaque source predicates; published voice authority does not make the shared query worker-only.",
    },
  ],
  [
    "src/config/sessions/session-accessor.sqlite-conversation.ts",
    {
      priority: 99,
      evidence:
        "All mutations flow through writeSessionEntry in entry-store.ts, or conversation.register in openclaw-agent-execution-operations.ts. The latter is worker-only; writeSessionEntry also serves opaque SDK transactions and CLI import. Preserve the mixed classification of the shared identity and association kernels.",
    },
  ],
  [
    "src/config/sessions/session-accessor.sqlite-delete-snapshot.ts",
    {
      priority: 99,
      evidence:
        "Workers and offline reset share this snapshot with SessionManager appendMessage/appendMessageWithTranscriptAnchor -> reloadPersistedTranscriptAfterAppend -> readSessionManagerReload -> inspectTranscriptEventsSync. Those synchronous SDK methods shipped in v2026.10.4. Keep the mixed tier and changed-user-data deletion check.",
    },
  ],
  [
    "src/config/sessions/session-accessor.sqlite-branch-rewrite.ts",
    {
      priority: 99,
      evidence:
        "prepareTranscriptRewriteSync serves session-manager-maintenance.worker.ts and deprecated SessionManager.prepareTranscriptRewrite, exported by plugin-sdk/agent-sessions and shipped in v2026.10.4. The synchronous SDK method remains supported through 2026-12-31; this shared kernel is not worker-only.",
    },
  ],
  [
    "src/config/sessions/session-accessor.sqlite-deletion.ts",
    {
      priority: 99,
      evidence:
        "The transaction wrapper serves workers/maintenance plus sqlite-transcript-turn.ts's native branch. plugin-sdk/session-transcript-runtime.appendSessionTranscriptMessageByIdentityStrict supplies prepareMessageAfterIdempotencyCheck, which excludes worker execution; that callback contract shipped in v2026.10.4.",
    },
  ],
  [
    "src/config/sessions/session-accessor.sqlite-display-position.ts",
    {
      priority: 99,
      evidence:
        "History workers share this query with plugin-sdk/session-transcript-runtime.readSessionTranscriptCatalogTitle -> readLegacySessionTranscriptCatalogTitle -> readSessionTranscriptHistoryEventPage. The synchronous SDK reader shipped in v2026.10.4 and remains deprecated through 2026-12-31.",
    },
  ],
  [
    "src/config/sessions/session-accessor.sqlite-provenance.ts",
    {
      priority: 99,
      evidence:
        "writeSessionEntry calls prepareSessionEntryWindowRow from workers and retained native initial-entry/transcript persistence. Actor/prepared window facts bypass the query, but released synchronous SessionManager persistence and opaque transcript callbacks still reach the fallback; keep it mixed.",
    },
  ],
  [
    "src/config/sessions/session-pending-input-store.ts",
    {
      priority: 99,
      evidence:
        "Only SessionPendingInputReceipt.complete invokes nativeMutation; completeAsync uses the worker. UserTurnTranscriptRecorder.completeProcessing exposes the same synchronous completion contract. Both SDK APIs shipped in v2026.10.4; retain their native transaction until the compatibility cutover.",
    },
  ],
  [
    "src/config/sessions/targets-discovery.native.ts",
    {
      priority: 99,
      evidence:
        "Worker topology shares discovery with plugin-sdk/session-transcript-hit.loadCombinedSessionStoreForGateway (shipped in v2026.10.4), through combined-store-gateway.native.ts and lineage.native.ts. resolveExistingAgentSessionStoreTargets also serves session-turn-predicate.ts in retained native transcript turns.",
    },
  ],
  [
    "src/cron/store/quarantine.kernel.ts",
    {
      tier: "T3",
      priority: 99,
      evidence: "Shared by worker operations and native Doctor store-repair transactions",
    },
  ],
  [
    "src/state/user-channel-identities.ts",
    {
      tier: "T3",
      priority: 99,
      evidence:
        "Gateway uses user-channel-identities.worker.ts and state-read; native resolver serves channel-operator-authority.ts CLI/updater capture via update-requester-authority.ts",
    },
  ],
  [
    "src/cron/store/runtime-authority-store.ts",
    {
      tier: "T3",
      priority: 99,
      evidence:
        "load/save kernels run in Cron workers; native save hooks only in commands/doctor/cron/legacy-repair.ts:395",
    },
  ],
  [
    "src/cron/store.ts",
    {
      tier: "T3",
      priority: 99,
      evidence:
        "Direct transaction uses Doctor legacy-repair.ts:395 hooks; ordinary load/save dispatch to workers; transitive current-authority SQL remains mixed",
    },
  ],
]);

// Match lexical operation paths, not moving line numbers or whole mixed modules.
const reviewedOperations = new Map([
  [
    "src/config/sessions/session-accessor.sqlite-read.ts",
    [
      {
        tier: "W",
        operations: ["loadTranscriptReadSnapshotSync"],
        binding: "result",
        evidence:
          "Only captureAuthoritativeMemoryEvents supplies readOnly: true, through readSessionMemoryCapture dispatched by session-history-read-operation.worker.ts or openclaw-agent-execution-operations.ts. Native SessionManager open/reload, loadTranscriptEventsSync, and transcript-commit.kernel.ts omit this option and return before this opener; their shared SQL remains T1.",
      },
      {
        tier: "W",
        operations: [
          "readTranscriptExportSnapshotReadOnlySync",
          "readTranscriptExportSnapshotReadOnlySync.transaction",
          "readTranscriptExportSnapshotsFromDatabase",
        ],
        evidence:
          "Transcript hydration, memory-entry export, and reset-recall dispatch run in transcript workers. Main-thread buildSessionEntry supplies a worker snapshot for SQLite; its in-process branch has no SQLite identity. Actor projection also receives a supplied snapshot. Other readers retain native SDK callers.",
      },
    ],
  ],
  [
    "src/infra/database-engine/agent-port-descriptor.ts",
    [
      {
        tier: "W",
        operations: [
          "loadAgentPortDescriptor.inspectSqliteSource",
          "loadAgentPortDescriptor.migrateSqliteSource",
        ],
        evidence:
          "inspectSqliteSource is called only by port-command.worker.ts inspectSqliteImage; migrateSqliteSource is called only by port.worker.ts migrateDatabasePortSource on the CLI's private source copy. Other descriptor consumers use admission/export operations, not these SQL callbacks.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-history-interval.ts",
    [
      {
        tier: "W",
        operations: [
          "readDisplayableActiveEventById",
          "readDisplayableActiveEventMetadataById",
          "countHistoricalDisplayEvents",
          "readHistoricalDisplayEventRange",
          "readHistoricalHistoryAnchorPage",
        ],
        evidence:
          "Only history-query's ID/lookup/anchor readers execute this SQL: session-transcript.worker.ts owns the readonly history reader; session-history-read-operation.worker.ts owns the prepared anchor-message callback. Native catalog title calls only the page reader; other imports use pure expression/parser helpers.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-history-projection.ts",
    [
      {
        tier: "W",
        operations: ["readActiveTranscriptCoordinate"],
        evidence:
          "Source pages run in session-history-worker-reader.ts under session-transcript.worker.ts. The other caller, resolveHistoryReadWindowChange, returns before this read without an expected anchor; deprecated catalog title's only native page calls supply no expectedReadWindow.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-closed-reset-interval.ts",
    [
      {
        tier: "W",
        operations: ["resolveClosedResetInterval"],
        evidence:
          "Closed intervals are called only by history-interval's worker-owned ID/anchor readers.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-reset-window.ts",
    [
      {
        tier: "W",
        operations: ["hasUnindexedVisibleMessages"],
        evidence:
          "Unindexed-message probing is called only by history-query's lookup reader, constructed by the readonly history reader inside session-transcript.worker.ts.",
      },
      {
        tier: "W",
        operations: ["readVisibleTranscriptStats"],
        evidence:
          "Only session-actor-context-stats.worker.ts and session-transcript-accounting.ts call this reader; accounting's sole production caller is the readonly history reader inside session-transcript.worker.ts.",
      },
      {
        tier: "W",
        operations: ["hasOversizedVisibleMessages"],
        evidence:
          "Only the bounded-tail projection's oversizedMessageCheck branch calls this query. Projection consumers run in workers; its native facade is used only by the title worker and Doctor title repair, neither of which supplies oversizedMessageCheck.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-pending-inputs.ts",
    [
      {
        tier: "T3",
        operations: ["deleteSessionPendingInputs"],
        evidence:
          "Only deleteSessionNodeArtifacts calls this deletion, from deleteSessionEntryRows. That entry-deletion owner runs in worker/maintenance lifecycle, reclamation, purge and finalization, or cleanup-utils.ts offline reset; it already has the same reviewed T3 classification.",
      },
    ],
  ],
  [
    "src/infra/backup-sqlite-snapshot.ts",
    [
      {
        tier: "T3",
        operations: ["createBackupSqliteSnapshotPlan.captureSource.capture.transform"],
        evidence:
          "commands/backup.ts:55 calls backup-create.ts:314; createVerifiedSqliteSnapshot invokes this transform against its temporary backup image, never the live credential store. Doctor/update backup and developer reliability callers share that offline snapshot owner.",
      },
    ],
  ],
  [
    "src/agents/auth-profiles/authorization-enrollment-runtime.ts",
    [
      {
        tier: "T3",
        operations: ["enrollOwnedAuthProfileAuthorization"],
        guard: "params.context.maintenanceScope?.ownsSchemaMaintenance",
        evidence:
          "Only the synchronous exclusive-Doctor branch opens the native agent transaction, with captured live admission, credential-preserving CAS and commit settlement. Ordinary shared/agent enrollment still dispatches through the existing worker/executor; nested callbacks and unguarded calls retain runtime classification.",
      },
    ],
  ],
  [
    "src/state/openclaw-state-db-legacy-backfills.ts",
    [
      {
        tier: "T2",
        operations: ["backfillAcpReplayEstimatedBytes"],
        evidence:
          "Only ensureAdditiveStateColumns calls this accounting repair, from schema-runtime cold admission/migration and the Doctor schema-repair runner; no Gateway runtime caller.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-replacement-read.ts",
    [
      {
        tier: "T3",
        operations: ["readSessionEntryReplacementLabelOwnerKeys"],
        evidence:
          "Label keys are read by the replacement snapshot helper in session-entry-read.worker.ts or the native replacement branch, and rechecked by replacement-state commit. The latter serves execution-worker commit or native replacement under worker/maintenance custody after the memory/worker split.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-replacement-projection.ts",
    [
      {
        tier: "T3",
        operations: ["applySqliteSessionEntryReplacementProjection.commit"],
        evidence:
          "Replacement returns memory state first. The commit callback reaches this transaction only when useWorker is false: creation always uses the worker, and ordinary main-thread durable replacement uses execution-worker commit. Native execution requires off-thread or schema/agent-maintenance custody; live deletion cleanup supplies workerAuthority.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-reclamation.ts",
    [
      {
        tier: "T3",
        operations: ["reclaimSqliteRowsInTransaction"],
        evidence:
          "The private row kernel is called only by reclaimSqliteSessionInTransaction. Its entrants are the archive mutation-worker runtime, session-native-binding.worker.ts and reclamation-run.ts, whose native branch requires off-thread or schema/agent-maintenance ownership; ordinary main-thread callers use worker dispatch.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-raw-delta-read.ts",
    [
      {
        tier: "T3",
        operations: ["readRawDeltaInTransaction"],
        evidence:
          "The database wrapper is called by session-history-read-operation.worker.ts and the execution-worker rawDelta operation. The projection wrapper is called only by history-query within the transcript worker reader lifetime. The unused native facade has only internal reexports; SDK delta readers use the async reader owner.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-projection.ts",
    [
      {
        tier: "T3",
        operations: ["applySessionEntryLifecycleMutation.commitProjectedLifecycleMutation"],
        evidence:
          "Lifecycle mutation returns memory state first and dispatches ordinary main-thread durable planning/commit to workers. This private native commit is called only after that split: off thread, schema/agent-maintenance custody, or allowCanonicalRepair set only by doctor-session-canonical-keys.ts. Live deletion cleanup supplies workerAuthority and retains dispatch.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-history-source.ts",
    [
      {
        tier: "T3",
        operations: ["readSessionTranscriptSourcePageFromProjection"],
        evidence:
          "Only session-transcript-read-kernel.ts calls this source projection. Its reader is constructed only in session-history-readonly-reader.ts, whose sole production constructor is gateway/session-history-worker-reader.ts under session-transcript.worker.ts.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-history-query.ts",
    [
      {
        tier: "T3",
        operations: ["readTranscriptDisplayDeltaFromProjection"],
        evidence:
          "Projection callers are the readonly history reader and transcript-read-kernel selection reader. The latter is constructed only by the former, whose sole production constructor is gateway/session-history-worker-reader.ts inside session-transcript.worker.ts.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-history-input-visibility.ts",
    [
      {
        tier: "T3",
        operations: ["readSessionTranscriptRunInputVisibilityFromProjection"],
        evidence:
          "Only the readonly history reader calls this projection. Its sole production constructor is gateway/session-history-worker-reader.ts, invoked by session-transcript.worker.ts; callbacks remain inside that worker-owned reader lifetime.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-entry-store.ts",
    [
      {
        tier: "T3",
        operations: [
          "deleteSessionEntryRows",
          "deleteLegacySessionEntryRows",
          "rehomeSessionWindows",
        ],
        evidence:
          "Entry deletion is reached by worker/maintenance lifecycle, reclamation, purge and finalization kernels, or cleanup-utils.ts offline reset. Legacy deletion and window rehome also serve replacement-state and Doctor legacy repair. Lifecycle/replacement dispatch durable main-thread work to workers after memory exits; legacy mutation requires doctor-fix, while startup, onboarding and agent creation use detect.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-entry-inventory.ts",
    [
      {
        tier: "T3",
        operations: ["readSessionEntryCount"],
        evidence:
          "Count callers are projection-state lifecycle commit and maintenance-store preparation, captured apply and fast-path read. Lifecycle native commits require maintenance custody; preparation/apply stays in the execution worker or its reclamation/native-maintenance branch. The fast-path reader is called only by worker maintenance reads.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-entry-clear.ts",
    [
      {
        tier: "T3",
        operations: ["clearSqliteSessionEntryPreservingWindows"],
        evidence:
          "Only deleteSessionEntryRows calls this clearer. Its callers are the worker/maintenance lifecycle projection, reclamation, agent-purge and maintenance-finalization kernels, plus resetSessionStore from cleanup-utils.ts offline reset.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-creation.ts",
    [
      {
        tier: "T3",
        operations: ["createSessionEntryWithTranscriptInScope.initialize"],
        evidence:
          "The creation entry returns memory state first. Ordinary main-thread durable creation retains the history worker and initializes there; this native initialize transaction runs only off thread or under schema/agent-maintenance custody. The only main-thread deletion-cleanup producer supplies workerAuthority, so it retains worker dispatch. Worker errors do not select this native branch.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-active-events.ts",
    [
      {
        tier: "T3",
        operations: [
          "readSessionTranscriptVisibleMessageDeltaCore",
          "resolveVisibleDeltaRange",
          "readVisibleDeltaMetadata",
          "readVisibleDeltaPayload",
        ],
        evidence:
          "Visible delta has only session-history-read-operation.worker.ts and the registered execution-worker visibleDelta operation as callers; the accessor reexport adds no native value caller. Its private range, metadata, and payload helpers are called only by the visible delta core.",
      },
    ],
  ],
  [
    "src/config/sessions/session-pending-input-source.kernel.ts",
    [
      {
        tier: "W",
        operations: ["readPendingInputSourceInDatabase"],
        evidence:
          "Only session-history-read-operation.worker.ts handles session-pending-input-source, or readPendingInput reaches this reader through session.pendingInputs.read in openclaw-agent-execution.worker.ts. The host native adapter invokes only completion.",
      },
    ],
  ],
  [
    "src/config/sessions/session-pending-input-operations.kernel.ts",
    [
      {
        tier: "W",
        operations: ["mutatePendingInput"],
        guard: 'input.kind === "stage"',
        evidence:
          "Stage SQL executes only through session.pendingInputs.mutate in openclaw-agent-execution.worker.ts or session-actor-phase.worker.ts. The host nativeMutation adapter accepts only complete, so this guard excludes native completion and its shared helpers.",
      },
      {
        tier: "W",
        operations: ["mutatePendingInput"],
        binding: "result",
        evidence:
          "The result initializer is the finish-only update reached through session.pendingInputs.mutate or session-actor-phase.worker.ts. Native complete calls writeSessionInputCompletion instead; the shared operation remains mixed.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-pending-input-receipts.ts",
    [
      {
        tier: "W",
        operations: ["listSessionPendingInputReceipts"],
        evidence:
          "Only session-history-read-operation.worker.ts invokes this receipt reader for session-pending-input-receipts. The host receipt facade and worker contracts import its type only.",
      },
    ],
  ],
  [
    "src/config/sessions/session-transcript-report-read.ts",
    [
      {
        tier: "W",
        operations: ["readTranscriptReportEvent"],
        evidence:
          "The report kernel calls this reader only through prepareTranscriptReportSelection and appendAbortedSessionTranscriptPartialInTransaction, invoked by session-accessor.sqlite-transcript-reports.worker.ts. The other caller is readSessionTranscriptMaintenance, invoked only by session-transcript-hydration-read.worker.ts. The host report facade uses only prepareCustomTranscriptReport serialization.",
      },
    ],
  ],
  [
    "src/session-cards/progress-card-store.ts",
    [
      {
        tier: "W",
        operations: ["selectProgressCard", "writePreparedSessionProgressCard.write"],
        evidence:
          "session-transcript.worker.ts owns card reads; progress-card-store.worker.ts owns writes and their fallback reads. Gateway references are type uses; other writeSessionProgressCard callers are fixtures.",
      },
      {
        tier: "T3",
        operations: ["clearProgressCardInTransaction"],
        evidence:
          "Durable single and batched resets run through the agent worker and clear the card in the reset transaction. Native lifecycle and canonical-repair callers require maintenance authority; incognito uses the memory actor. progress-card-store.worker.ts also invokes this clearer for conditional card writes.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-entry-replace.ts",
    [
      {
        tier: "W",
        operations: ["replaceSessionEntrySync"],
        evidence:
          "The only production caller is applyPreparedTranscriptCommit in gateway/worker-environments/transcript-commit.kernel.ts, invoked by transcript-commit.worker.ts. Other callers are fixtures; the remaining entry operations retain their own classifications.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-owner.ts",
    [
      {
        tier: "W",
        operations: ["assignSessionOwner"],
        evidence:
          "Only session-sharing-store.worker.ts executes assignSessionOwner under owner.assign; session-metadata-write.async.ts dispatches through runSessionCollaborationWrite. The accessor reexport serves fixtures. Owner replacement has a separate worker/maintenance classification.",
      },
      {
        tier: "T3",
        operations: ["replaceSessionOwnerInTransaction"],
        evidence:
          "Owner replacement serves worker/maintenance lifecycle and replacement commits, Doctor canonical/legacy repair, the offline team-shape-sessions fixture CLI, and assignSessionOwner. Only session-sharing-store.worker.ts calls assignSessionOwner in production; its accessor reexport adds no native SDK caller.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-entry-read.ts",
    [
      {
        tier: "W",
        operations: ["readSessionChildEntriesInDatabase"],
        evidence:
          "Only session-entry-read.worker.ts invokes the child-entry reader. Other readers in this module retain native SDK and maintenance callers.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-maintenance-store.ts",
    [
      {
        tier: "W",
        operations: ["readSessionTranscriptJsonlBytesInDatabase"],
        evidence:
          "Only openclaw-agent-execution-operations.ts handles session.maintenance.size and session-accessor.sqlite-archive.worker.ts handles maintenance-size with this reader. Other maintenance preparation operations remain mixed.",
      },
      {
        tier: "T3",
        operations: ["prepareSessionEntryMaintenanceInDatabase.readInputs"],
        evidence:
          "Preparation is called only by maintenance-transaction worker prepare/read and inline maintenance. The captured apply remains in the execution-worker maintenance owner or runs immediately in inline lifecycle/replacement/purge/reclamation commits; their native branches require maintenance custody. Both readInputs calls therefore retain the same worker/maintenance ownership.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-entry-write.ts",
    [
      {
        tier: "T3",
        operations: ["writeArchivedSessionEntries.flush"],
        evidence:
          "Only maintenance-store calls the archive batch writer. Its captured apply runs in execution-worker maintenance or immediate inline lifecycle/replacement/purge/reclamation commits whose native branches require maintenance custody. Ordinary entry writes retain their existing mixed ownership.",
      },
    ],
  ],
  [
    "src/config/sessions/session-transcript-context-versions.ts",
    [
      {
        tier: "T3",
        operations: ["readTranscriptContextVersionsInTransaction"],
        evidence:
          "Only maintenance-store calls the batch version reader, during worker preparation and captured apply or immediate inline maintenance. Native lifecycle/replacement/purge/reclamation commits require maintenance custody, matching maintenance-store readInputs ownership.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-history-recency.ts",
    [
      {
        tier: "T3",
        operations: ["recentSessionHistoryIds"],
        evidence:
          "Shared collector/probe query. readHistoricalSessionIdsInDatabase calls the collector through session-transcript.worker.ts or explicit CLI reclamationMode=in-process. Only reclamation.ts and archive.worker.ts materialization call the probe; native reclamation requires an off-thread or schema/agent-maintenance owner, and ordinary durable callers dispatch to workers.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.reset.ts",
    [
      {
        tier: "T3",
        operations: ["loadReplySessionInitializationEntriesForMaintenance"],
        evidence:
          "Reply initialization resolves memory first and uses readExactEntries for supported database execution. This helper is reached only when supportsOpenClawAgentDatabaseExecution is false under exclusive native maintenance; ordinary Gateway and deletion cleanup retain their worker authority.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-lifecycle.ts",
    [
      {
        tier: "T3",
        operations: ["resetSessionEntryLifecycleForMaintenance"],
        evidence:
          "resetSessionEntryLifecycle dispatches ordinary main-thread database execution to resetSessionEntryInWorker after the memory path. This native helper serves exclusive maintenance or worker execution; ordinary agent-deletion cleanup supplies workerAuthority.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-lifecycle-artifacts.ts",
    [
      {
        tier: "T3",
        operations: [
          "prepareSessionLifecycleArtifactCleanupForMaintenance",
          "planSessionLifecycleArtifactCleanupPages",
          "readOrphanWindowPage",
          "sqliteTranscriptStateIsReclaimable",
        ],
        evidence:
          "sqlite-artifact-cleanup.ts uses the history worker whenever main-thread database execution is supported, and returns for absent stores before planning. Native planning is exclusive maintenance only; session-transcript.worker.ts is the other planner caller. Agent deletion supplies workerAuthority and memory cleanup never reaches these SQL paths.",
      },
    ],
  ],
  [
    "src/acp/runtime/session-meta-write.native.ts",
    [
      {
        tier: "T3",
        operations: [
          "upsertAcpSessionMetaForMaintenance",
          "upsertAcpSessionMetaForMaintenance.publish",
        ],
        evidence:
          "Only session-meta-write.ts calls this native adapter when supportsOpenClawAgentDatabaseExecution is false under exclusive schema/agent maintenance. Ordinary writes dispatch to the worker; agent-deletion cleanup supplies workerAuthority, and memory readers have no file scope for this adapter.",
      },
    ],
  ],
  [
    "src/config/sessions/session-history-eviction-candidates.ts",
    [
      {
        tier: "W",
        operations: ["readDiskEvictableArchivedSessionBatchInDatabase"],
        evidence:
          "Only session-transcript.worker.ts reads archived eviction batches after the incognito disk path was removed. Native historical-ID reads are CLI cleanup; admission-reference readers retain separate classifications.",
      },
      {
        tier: "T3",
        operations: ["readHistoricalSessionIdsInDatabase"],
        evidence:
          "session-transcript.worker.ts reads historical IDs in the worker; session-history-eviction.ts calls the native reader only for reclamationMode=in-process, selected in production only by commands/sessions-cleanup.runtime.ts.",
      },
    ],
  ],
  [
    "src/config/sessions/session-reaction-store.kernel.ts",
    [
      {
        tier: "W",
        operations: ["setSessionReactionInDatabase"],
        evidence:
          "Only the agent execution worker reaction registry invokes this SQL kernel. The host imports its error classes; incognito mutations run through the memory actor.",
      },
    ],
  ],
  [
    "src/config/sessions/session-transcript-search.ts",
    [
      {
        tier: "W",
        operations: ["searchSessionTranscriptsReadOnlySync"],
        evidence:
          "The synchronous search operation is called only by session-transcript.worker.ts. The async facade reads memory actor history directly and never enters SQLite for incognito sessions.",
      },
    ],
  ],
  [
    "src/infra/outbound/current-conversation-bindings.ts",
    [
      {
        tier: "T3",
        operations: ["clearPersistedCurrentConversationBindingsForTests"],
        evidence:
          "Explicit testing SDK namespace only: session-binding-service.ts testing.resetSessionBindingAdaptersForTests calls this reset; its callers are tests and contracts/test-helpers/session-binding-registry-backed-contract.ts beforeEach. No production binding cleanup calls it.",
      },
    ],
  ],
  [
    "src/flows/doctor-tool-schema-projection.ts",
    [
      {
        tier: "T3",
        operations: ["collectAgentRuntimeToolSchemaFindings"],
        evidence:
          "Only doctor-tool-schema-runtime.ts invokes this projection through collectRuntimeToolSchemaFindings, wired exclusively into doctor-core-checks.ts by doctor-tool-schema-check.ts. Its synchronous tool construction runs under withPluginRuntimeGenerationRegistryScope during the Doctor one-shot.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-participants.native.ts",
    [
      {
        tier: "W",
        operations: ["recordSessionParticipantFromWorker"],
        evidence:
          "Only session-sharing-store.worker.ts invokes this worker entry. The separate native participant entry resolves aliases from the resident Gateway catalog.",
      },
    ],
  ],
  [
    "src/gateway/channel-operator-authority.ts",
    [
      {
        tier: "T3",
        operations: [
          "resolveChannelOperatorAdminAuthority",
          "resolveUpdateChannelOperatorAdminIdentityAuthority",
        ],
        evidence:
          "Native identity capture is private to resolveChannelOperatorAdminAuthority and resolveUpdateChannelOperatorAdminIdentityAuthority; command-auth.ts passes those only to the CLI/updater captureCommandOwnerIdentity path used by update-requester-authority.ts. Gateway ingress awaits prepareChannelOperatorAdmin instead. Returned currency checks preserve update execution authority.",
      },
    ],
  ],
  [
    "src/state/user-profiles-owner-migration.ts",
    [
      {
        tier: "T3",
        operations: ["repairMergedGatewayOwnerProfile"],
        evidence:
          "Doctor repair-sequencing.ts invokes merged-owner repair; preview-warnings.ts invokes the same entry with shouldRepair false. No Gateway caller.",
      },
    ],
  ],
  [
    "src/state/user-channel-identities.ts",
    [
      {
        tier: "W",
        operations: ["linkUserChannelIdentity", "unlinkUserChannelIdentity"],
        evidence:
          "Only user-channel-identities.worker.ts executes channel link/unlink mutations; Gateway callers await the registered worker operations.",
      },
    ],
  ],
  [
    "src/state/user-profiles-tailscale-migration.ts",
    [
      {
        tier: "T3",
        operations: ["migrateLegacyTailscaleProfileIdentities"],
        evidence:
          "Only commands/doctor/repair-sequencing.ts invokes the legacy Tailscale identity repair.",
      },
    ],
  ],
  [
    "src/state/openclaw-quarantine-store.ts",
    [
      {
        tier: "T2",
        operations: [
          "readOpenClawAgentIntegrityVerification.read",
          "recordOpenClawAgentIntegrityVerification",
          "invalidateAgentIntegrityVerification",
          "markOpenClawAgentIntegrityClean",
        ],
        evidence:
          "Integrity lease primitives: openclaw-agent-db-lease.ts reads during claim/reclaim, records admission, invalidates stale/unclean leases and marks final release. Failed native close invalidates before releasing its lease; schema-inspection.worker.ts also reads receipts. These are admission/release/repair exceptions, not ordinary Gateway queries.",
      },
    ],
  ],
  [
    "src/state/agent-deletion-journal-history.ts",
    [
      {
        tier: "T2",
        operations: ["hasPreJournalStateSchema"],
        evidence:
          "Missing-schema admission only: openclaw-state-db-schema-runtime.ts initialization, openclaw-state-db-repair.ts and readRetainedAgentDeletionsFromDatabase's pre-journal compatibility branch.",
      },
    ],
  ],
  [
    "src/state/openclaw-agent-db-metadata-write.ts",
    [
      {
        tier: "T2",
        operations: ["persistAgentSchemaMetadata"],
        evidence:
          "Only openclaw-agent-db-schema-helpers.ts and openclaw-agent-db-schema.ts call this schema admission/migration writer.",
      },
    ],
  ],
  [
    "src/state/openclaw-state-db-maintenance.ts",
    [
      {
        tier: "T2",
        operations: ["writeCurrentStateSchemaMetadata"],
        evidence:
          "Only openclaw-state-db-schema-runtime.ts schema initialization/admission writes the current schema marker.",
      },
    ],
  ],
  [
    "src/state/user-github-connections.kernel.ts",
    [
      {
        tier: "W",
        operations: ["listUserGitHubConnectionsInDatabase"],
        evidence: "Only user-github-connections.worker.ts dispatches the connection listing.",
      },
    ],
  ],
  [
    "src/state/user-profile-mutation.ts",
    [
      {
        tier: "T2",
        operations: ["runUserProfileWriteTransaction"],
        evidence:
          "Profile mutations run in user-profile-writes.worker.ts and user-profiles.worker.ts; native user-profiles-schema.ts uses this only for once-per-load schema initialization.",
      },
    ],
  ],
  [
    "src/secrets/store/secret-store-hidden-github.kernel.ts",
    [
      {
        tier: "W",
        operations: ["writePersonalGitHubSecret"],
        guard: "value === null",
        evidence:
          "Only user-github-connections.kernel.ts mergeUserGitHubConnection passes null, through user-profiles-merge.ts in user-profile-writes.worker.ts. Native personal cancel/disconnect pass serialized records and retain the shared upsert path.",
      },
      {
        tier: "W",
        operations: ["listHiddenGitHubSecretsInDatabase"],
        evidence:
          "Only githubSecrets.list in secret-store-github-handoff.worker.ts selects hidden record listings; native SDK compatibility uses exact read/delete operations only.",
      },
    ],
  ],
  [
    "src/config/io.health-state.kernel.ts",
    [
      {
        tier: "W",
        operations: ["patchConfigHealthEntryInDatabase"],
        evidence:
          "Only configSnapshotOperations[config.health.patch] in config-journal-snapshot.worker.ts calls this conditional patch through the shared-state worker. Native config compatibility reads and writes remain T1.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-acp-provenance.ts",
    [
      {
        tier: "T3",
        operations: ["prepareLegacyAcpMigrationSourcesForEntryWrite"],
        evidence:
          "entry-store.ts is the sole caller. This read requires changed sessionId/lifecycleRevision and a partial provenance snapshot. Native transcript/compaction compatibility preserves identity; reset/replacement/message-cut/fork/recovery use workers. Doctor import/repair retains native partial snapshots. Opaque deletion callbacks now become worker finalizers via session-deletion-worker-participant.ts.",
      },
      {
        tier: "T3",
        operations: ["readSources", "writeSources"],
        evidence:
          "Legacy provenance import/repair only: recordLegacyAcpMigrationSources is called by sqlite-import.ts, and copyLegacyAcpMigrationSourcesForRepair by sqlite-node-artifacts.ts. Runtime entry writes and clearing persist provenance with their existing node upsert.",
      },
      {
        tier: "T3",
        operations: ["readLegacyAcpMigrationContext"],
        evidence:
          "Only the exclusive-maintenance adapter session-meta-write.native.ts and state-migrations.acp-session-metadata.ts call this native wrapper. Runtime source reads use readLegacyAcpMigrationContextInDatabase in the worker; prepareLegacyAcpMigrationSourcesForEntryWrite remains mixed.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-lifecycle-state.ts",
    [
      {
        tier: "T2",
        operations: ["assertRawSessionEntryRemovalUnchanged"],
        evidence:
          "Doctor-only raw-row removal: commands/doctor-session-canonical-keys.ts constructs expectedRawEntryJson; lifecycle-state.ts and projection-state.ts call this guard only for that removal variant. Other lifecycle operations retain their separate classifications.",
      },
      {
        tier: "T3",
        operations: ["deleteSqliteSessionStateRows"],
        evidence:
          "Physical deletion is private to materialized-state deletion, called by lifecycle/reclamation/purge kernels and worker or reclamation maintenance finalization. Native branches require worker or maintenance custody.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-references.ts",
    [
      {
        tier: "T3",
        operations: ["readSessionGenerationIdsForKeys"],
        evidence:
          "Moved unchanged from lifecycle-state.ts. Generation reads serve lifecycle planning, deletion planning, maintenance apply and Doctor canonical-repair aliases. Native lifecycle/reclamation/purge branches require worker or maintenance custody; deletion planning with expectedDatabaseIdentity is produced only by Doctor legacy repair.",
      },
    ],
  ],
  [
    "src/agents/auth-profiles/sqlite-json.ts",
    [
      {
        tier: "W",
        operations: ["readAuthProfileRows", "readAuthProfileJsonCellTexts"],
        evidence:
          "Auth-profile inspection workers and the shared/agent usage workers call these paired readers; synchronous SDK cell readers remain T1.",
      },
    ],
  ],
  [
    "src/agents/auth-profiles/shared-store-bootstrap.ts",
    [
      {
        tier: "T2",
        operations: [
          "readSharedAuthLegacyRowsFromDatabase",
          "hasPendingSharedAuthCleanupInDatabase",
        ],
        evidence:
          "First-load legacy shared-auth admission and migration only: initializeFreshSharedAuthStore skips already-inspected ownership; shared-store-bootstrap.worker.ts and Doctor own remaining callers.",
      },
    ],
  ],
  [
    "src/plugin-state/plugin-state-store.reads.ts",
    [
      {
        tier: "W",
        operations: ["selectPluginStateBatchRows"],
        evidence:
          "Only the invocation-bound plugin-state-operation.kernel.ts facade calls this row reader; that facade executes in plugin-state.worker.ts. Existing native scalar readers remain separately classified.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-transcript-state.ts",
    [
      {
        tier: "T3",
        operations: ["deleteTranscriptEventsInTransaction"],
        evidence:
          "Full replacement only: manual/message-rewrite workers, maintenance-worker branching, internal correction behind !isMainThread, and Doctor header repair. The native manual-compaction adapter is deleted; released SDK append/suffix callbacks do not expose full replacement.",
      },
      {
        tier: "T3",
        operations: ["pruneTranscriptReactionsInTransaction"],
        guard: "removedEventIds === undefined",
        evidence:
          "Only full transcript replacement passes no removed IDs, via workers, worker-guarded correction, or Doctor header repair after native manual compaction removal. The bounded suffix branch still serves released synchronous SessionManager.removeTrailingEntries and remains T1.",
      },
      {
        tier: "W",
        operations: ["advanceTranscriptMutationAtInTransaction"],
        guard: "actor?.window",
        evidence:
          "Only the actor-window UPDATE is covered. readSessionActorTransactionState returns facts installed by withSessionActorTransactionState, whose only production caller is session-actor.worker.ts. The unbound RETURNING update remains mixed; the raw migration update retains its separate exception.",
      },
      {
        tier: "T2",
        operations: ["advanceTranscriptMutationAtInTransaction"],
        guard: "!findOpenClawAgentDatabaseIdentity(database)",
        evidence:
          "Only the unadmitted legacy UPDATE is guarded here. createMigrationDatabaseHandle in state-migrations.agent-database.ts supplies raw media/directive migration handles. Durable runtime openers register identity before exposure; their RETURNING executor remains T1.",
      },
    ],
  ],
  [
    "src/plugins/installed-plugin-index-store-write.ts",
    [
      {
        tier: "W",
        operations: [
          "readInstalledPluginIndexRow",
          "writePersistedInstalledPluginIndexToSqlite",
          "restorePersistedInstalledPluginIndexInDatabase",
        ],
        evidence:
          "Live install-record commits, direct index writes, refresh, and exact-revision rollback dispatch through plugins/state.worker.ts under the retained lifecycle lease. Source-admission publication uses that worker too. The synchronous refresh kernel has no remaining non-worker production callers.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-maintenance-transaction.ts",
    [
      {
        tier: "T3",
        operations: [
          "runSessionMaintenanceMetadataInTransaction",
          "runSessionMaintenanceMetadataInTransaction.run",
        ],
        evidence:
          "Only openclaw-agent-execution-maintenance.ts and runSessionMaintenanceMetadataInDatabase call this transaction. The former is registered solely in the execution worker; the latter is called only by the reclamation kernel, whose native branch requires an off-thread or schema/agent-maintenance owner. Its local run callback stays synchronous and never escapes: PostgreSQL invokes it directly; SQLite invokes it inside runWithSqliteBusyTimeout.",
      },
    ],
  ],
  [
    "src/infra/gateway-boot-lifecycle.kernel.ts",
    [
      {
        tier: "W",
        operations: [
          "readGatewayLastShutdownInDatabase",
          "inspectGatewayCrashLoopBreakerInDatabase",
        ],
        evidence:
          "SQL readers execute only through gatewayBootReadOperations in the shared-state read worker or gatewayBootOperations begin/recover in the shared-state writer. Host lifecycle APIs dispatch these operations; remaining host imports from this kernel are pure helpers and constants.",
      },
    ],
  ],
  [
    "src/infra/gateway-owner-lease.ts",
    [
      {
        tier: "T2",
        operations: ["acquireGatewayOwnerLease"],
        binding: "acquired",
        evidence:
          "gateway-lock.ts calls acquisition only after obtaining physical Gateway state custody. This conditional upsert is the process-lock claim; the previous owner is checked in the same transaction. Runtime renewal uses the state lease worker.",
      },
    ],
  ],
  [
    "src/state/openclaw-state-db.ts",
    [
      {
        tier: "T2",
        operations: ["reconcileOpenClawStateSchemaPublication"],
        evidence:
          "Native callers are openOpenClawStateDatabaseWithBusyTimeout admission; the Gateway watcher awaits reconcileOpenClawStateSchemaPublicationAsync, dispatched as database.publishSchema by openclaw-state.worker.ts. The transaction publishes the admitted schema under exclusive schema maintenance.",
      },
      {
        tier: "T2",
        operations: ["withOpenClawStateStartupMigrationCheckpointDatabase"],
        evidence:
          "Startup checkpoint callers only: startup-migration-checkpoint.ts:84,157 serves CLI startup-config-preflight.ts admission/heartbeat/release; gateway-owner-lease.ts:253,282 claims/releases the process lock, whose runtime heartbeat already uses openclaw-state-lease-heartbeat.ts. Other shared-state writes remain T1.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-reset.ts",
    [
      {
        tier: "T3",
        operations: ["readResetInventory", "previewSessionStoreReset"],
        evidence:
          "Only cleanup-utils.ts:620,628,641 reaches full-store reset from reset.ts:154 and onboard-helpers.ts:254, including CLI dev bootstrap; Gateway session reset is separate",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-archive-store-kernel.ts",
    [
      {
        tier: "T3",
        operations: [
          "readSessionTranscriptArchiveResetInventory",
          "deleteAllSessionTranscriptArchivesInTransaction",
        ],
        evidence:
          "Only offline full-store reset calls these at session-accessor.sqlite-reset.ts:65,239 via commands/cleanup-utils.ts; other archive operations retain native lifecycle callers",
      },
      {
        tier: "W",
        operations: ["hasPendingSessionTranscriptArchives"],
        evidence:
          "Direct callers are session-entry-read.worker.ts, session-lifecycle-projection.worker.ts and session-transcript.worker.ts. replacement-state.ts calls only when checkPendingArchiveRecovery is true; only sqlite-creation.ts sets that flag, and its creation replacement always selects the worker in replacement-projection.ts.",
      },
      {
        tier: "T3",
        operations: [
          "prepareSessionTranscriptArchivePublishPlans",
          "recordSessionTranscriptArchivePublishResults",
        ],
        evidence:
          "Only archive-transaction.ts:24,30 and openclaw-agent-execution-operations.ts:433,445 call prepare/record. Runtime publication dispatches through session-archive-publication.ts to the agent execution worker. The alternate archive-store.ts route passes reclamation-run.ts:68,140: native reclamation requires a worker or explicit schema/agent maintenance custody; !supportsOpenClawAgentDatabaseExecution alone never admits native reclamation.",
      },
      {
        tier: "T3",
        operations: ["persistSessionTranscriptArchive"],
        evidence:
          "Only deleteMaterializedSessionStatePlans calls this: reclamation-run.ts admits native work only in workers/maintenance; projection.ts retains Doctor canonical repair; agent purge receives workerAuthority from agent-lifecycle-registry.ts. Opaque deletion callbacks become worker post-commit finalizers in session-deletion-worker-participant.ts. Archive conflict and final deletion snapshot checks remain intact.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-archive-transaction.ts",
    [
      {
        tier: "T3",
        operations: ["reclaimSessionArchivePublicationInTransaction"],
        evidence:
          "Only session-accessor.sqlite-reclamation.ts:204 calls this archive-publish-prepare/record transaction. Incoming reclamation passes reclamation-run.ts:68,140: !isMainThread or exclusive schema/agent maintenance permits native work; ordinary runtime dispatches to session-accessor.sqlite-archive.worker.ts:500-512. Agent execution publication uses its own worker transaction.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-transcript-anchor.ts",
    [
      {
        tier: "T3",
        operations: ["readActiveTranscriptEntryIdentityInSnapshot"],
        evidence:
          "Current-turn, anchor, activity and entry-patch reads execute in workers. The native entry-patch branch requires !useWorker; execution-scope permits durable native work only under maintenance/cleanup custody. chat-send-active-leaf.ts calls the relation helper only for incognito, whose database opener rejects before SQLite. No SDK value export; the sibling anchor-facts query remains mixed.",
      },
      {
        tier: "T3",
        operations: ["assertSessionTranscriptContextAnchorInDatabase"],
        guard: "expectedAuthority",
        evidence:
          "Only the expectedAuthority SELECT is covered. model-context.ts:202 forwards it from anchor-read.kernel.ts:215; callers are entry-read, entry-cohort, hydration-read and history-read-operation workers, plus openclaw-agent-execution-operations.ts:185 registered in execution.worker.ts:454. Runtime anchor readers use owned cohorts or transcript-worker readAnchors. Released detached validators accept only version/admission, and withTranscriptContextSnapshot omits expectedAuthority; shared anchor helpers remain mixed.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-transcript-metadata-read.ts",
    [
      {
        tier: "W",
        operations: ["hasSessionTranscriptMessageInDatabase"],
        evidence:
          "Only session-transcript-anchor-read.kernel.ts and session-history-read-operation.worker.ts call this query. The anchor kernel is reached by entry-read, entry-cohort, hydration-read and history-read-operation workers, plus openclaw-agent-execution-operations.ts registered in execution.worker.ts. The sibling header query retains its synchronous SDK callers.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-transcript-message-rewrite.ts",
    [
      {
        tier: "T3",
        operations: [
          "rewriteNativeAssistantTranscriptMessageForRun",
          "rewriteNativeTranscriptMessageAtAnchor",
        ],
        evidence:
          "The sole production value callers are session-message-rewrite.ts:160,193, each dominated by !isMainThread at :159,191. Main-thread callers take rewritePreparedTranscriptMessage at :176,208. Neither native helper has a plugin-SDK value export; the surrounding mixed module is not exempted.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-transcript-store.ts",
    [
      {
        tier: "W",
        operations: ["replaceSqliteTranscriptEventsInTransaction"],
        evidence:
          "Full replacement runs only inside worker write transactions: session-manual-compact.worker.ts:59, session-message-rewrite.worker.ts:371, session-manager-maintenance.worker.ts:46 through session-accessor.sqlite-transcript-write.ts:131, and runNativeTranscriptWriteLock.replaceEvents (reviewed W); doctor-session-transcript-headers.ts:195 is a Doctor one-shot. Append and other operations in this mixed module stay T1.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-transcript-write.ts",
    [
      {
        tier: "W",
        operations: ["runNativeTranscriptWriteLock.replaceEvents"],
        evidence:
          "The full replacement method is consumed only by session-transcript-correction.ts runNative, invoked under !isMainThread. Public transcript and Codex mirror SDK callbacks receive projected contexts without replaceEvents; their append/read methods remain mixed. Internal accessor barrels and the private SDK context projector are not public entry points.",
      },
      {
        tier: "T3",
        operations: ["appendTranscriptEvent", "rewriteTranscriptEventRowsExact"],
        evidence:
          "Raw append's only production caller is session-transcript-event.ts:94 under !isMainThread; memory returns earlier and main-thread append dispatches to its worker. sqlite-runtime-testing.ts is a private first-party test helper excluded from the published package. Exact-row rewrite is called only by session-transcript-correction.ts:164 inside runNative, invoked solely under !isMainThread at :190. Internal re-exports are not runtime roots; snapshot/SDK siblings stay mixed.",
      },
    ],
  ],
  [
    "src/config/sessions/session-transcript-index.ts",
    [
      {
        tier: "T3",
        operations: [
          "deleteOrphanedTranscriptIndexRowsInTransaction",
          "listSessionsNeedingTranscriptIndexReconcile",
        ],
        evidence:
          "Only reconcile.ts:205,206,280 and projection-writer.ts:299,301 call these full scans, in no-execution/publication branches. Ordinary durable reconcile/search captures agent execution and uses projection-publication.worker.ts maintained status. Memory returns before SQL; execution-scope.ts:93-112 confines unsupported execution to explicit maintenance or worker-native deletion cleanup. Synchronous per-session rebuild uses separate helpers.",
      },
    ],
  ],
  [
    "src/config/sessions/session-transcript-projection-rebuild.ts",
    [
      {
        tier: "T3",
        operations: [
          "claimPreparedSessionTranscriptProjectionInTransaction",
          "deletePreparedSessionTranscriptProjectionChunkInTransaction",
          "finalizePreparedSessionTranscriptProjectionInTransaction",
          "insertPreparedSessionTranscriptProjectionRows",
          "prepareProjectionTailCatchUp",
          "projectionTailFitsCatchUpBounds",
          "readProjectionSourceSnapshot",
        ],
        evidence:
          "Prepared claim/delete/append/finalize are called only by projection-writer.ts:124,143,184,212 and projection-publication.worker.ts:118-128; snapshot/tail/insertion helpers are private descendants. reconcile.ts:175-192 supplies publication for ordinary durable execution. Memory returns first; execution-scope.ts:93-112 confines native branches to explicit maintenance or worker-native cleanup. The synchronous index.ts:497-531 rebuild uses visitSessionTranscriptProjection/readProjectionSource, not these operations.",
      },
    ],
  ],
  [
    "src/config/sessions/session-transcript-projection-writer.ts",
    [
      {
        tier: "T3",
        operations: ["finalizePreparedProjection", "runProjectionWrite.write"],
        evidence:
          "runProjectionWrite is called only by this module's native claim/delete/append/finalize/status branches and reconcile.ts:201,277 without publication. Durable reconcile/search uses the publication worker; finalize's worker branch returns before its SELECT. Memory returns before SQL; execution-scope.ts:93-112 limits unsupported execution to maintenance or worker-native cleanup, whose sole host factory supplies workerAuthority in agent-lifecycle-registry.ts:436-439.",
      },
    ],
  ],
  [
    "src/config/sessions/session-transcript-reconcile-readiness.ts",
    [
      {
        tier: "T3",
        operations: ["readSessionTranscriptProjectionStatus"],
        evidence:
          "Only reconcile.ts:557 calls this after waitForSessionTranscriptProjection's memory return and running-reconcile check. Supported durable execution dispatches via withSessionHistoryWorkerDatabase to session-transcript.worker.ts:460-470. Native reads require the maintenance/worker-native cleanup scopes in execution-scope.ts:93-112; failed execution capture or worker admission never falls back to native SQL.",
      },
    ],
  ],
  [
    "src/infra/update-managed-service-handoff-database-recovery.ts",
    [
      {
        tier: "T3",
        operations: ["recoverManagedUpdateLeaseJournal.read"],
        evidence:
          "Explicit update recover CLI -> recoverImmutableUpdate -> withImmutableUpdateOwner({ recover: true }) only; ordinary lease and Gateway readers never call this cold-journal admission",
      },
    ],
  ],
  [
    "src/config/sessions/session-claim-repair-copy.ts",
    [
      {
        tier: "T2",
        operations: ["copySessionClaimForRepair"],
        evidence:
          "Extracted from legacy-main-session-migration-operations.ts:copyClaimCrossStore. Its only callers are processIdenticalClaims after doctor-fix admission and doctor-relative-session-store.ts under exclusive Doctor maintenance; detect mode returns before copying. Source claims are rechecked inside the destination write transaction.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-delivery-repair.ts",
    [
      {
        tier: "T2",
        operations: ["copySessionDeliveriesForRepair", "readSessionDeliveryRepairInventory"],
        evidence:
          "Copy extracted from the reviewed copySqliteSessionOwnedStateForRepair operation in canonical-repair.ts; its other caller is Doctor-only copySessionClaimForRepair. Inventory is called only by doctor-relative-session-store-preservation.ts for offline pre-copy verification and completion fingerprints. No Gateway runtime caller.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-canonical-repair.ts",
    [
      {
        tier: "T2",
        operations: [
          "ensureSqliteTranscriptGenerationsForCanonicalRepair",
          "rehomeSqliteSessionDeliveryReferencesForCanonicalRepairBatch",
          "copySqliteSessionOwnedStateForRepair",
          "readExactSessionEntryRowForCanonicalRepair",
        ],
        evidence:
          "Doctor canonical-key repair/import and worker-only legacy comparison in session-retirement-read.worker.ts; native full claims run only after detect returns, and allowCanonicalRepair is supplied only by Doctor canonical-key repair",
      },
    ],
  ],
  [
    "src/config/sessions/legacy-main-session-key-scan.ts",
    [
      {
        tier: "T2",
        operations: ["readClaimsFromStores", "readClaimsFromStores.readStore"],
        evidence:
          "legacy-main-session-migration.ts calls full native claims only after detect mode returns; detection uses prepareComparisonClaimsFromStores and session-retirement-read.worker.ts",
      },
    ],
  ],
  [
    "src/gateway/worker-environments/placement-session-tool-operations.kernel.ts",
    [
      {
        tier: "W",
        operations: [
          "deleteWorkerTurnToolState",
          "closeWorkerTurnToolAdmission",
          "clearWorkerTurnToolState",
          "createPlacementSessionToolOperationKernel.hasToolAuthority",
          "createPlacementSessionToolOperationKernel.settleWorkerSessionToolOperation",
          "createPlacementSessionToolOperationKernel.authorize",
          "createPlacementSessionToolOperationKernel.clear",
          "createPlacementSessionToolOperationKernel.begin",
          "createPlacementSessionToolOperationKernel.bindChild",
          "createPlacementSessionToolOperationKernel.recover",
        ],
        evidence:
          "Factory runs in placement-session-tool-operations.worker.ts; claim, reconcile and terminal-failure cleanup now only run through placement-turn-claims.worker.ts",
      },
    ],
  ],
  [
    "src/gateway/worker-environments/placement-pending-failure.ts",
    [
      {
        tier: "W",
        operations: [
          "createPlacementPendingFailureOps.failWorkspaceResultAndReleaseTurn",
          "createPlacementPendingFailureOps.failWorkspaceResultAndReleaseTurn.transition",
        ],
        evidence:
          "Only placementTurns.failResult in placement-turn-claims.worker.ts constructs the terminal-failure kernel, including its transaction-local transition helper; all runtime callers await its worker facade",
      },
    ],
  ],
  [
    "src/gateway/worker-environments/placement-turn-claims.ts",
    [
      {
        tier: "W",
        operations: [
          "createPlacementTurnClaimOps.releaseTurn",
          "createPlacementTurnClaimOps.updateWorkspaceBaseManifest",
        ],
        evidence:
          "placement-store.ts:132 supplies worker mutations; placement-turn-claims.worker.ts:299,355,360 executes release/manifest methods",
      },
      {
        tier: "W",
        operations: [
          "createPlacementTurnClaimOps.publishTurnRelease",
          "createPlacementTurnClaimOps.claimTurnInDatabase",
          "createPlacementTurnClaimOps.cancelWorkspaceResultAndReleaseTurn",
        ],
        evidence:
          "Claim/release/cancel mutations run only through placement-turn-claims.worker.ts; host wait and validation consume async reads and published claim facts.",
      },
      {
        tier: "W",
        operations: ["clearLocalTurnClaimsInDatabase"],
        evidence:
          "Only placement-lifecycle.worker.ts clears local claims after restart; the released synchronous SDK method now rejects with async migration guidance.",
      },
    ],
  ],
  [
    "src/gateway/worker-environments/placement-workspace-journal.ts",
    [
      {
        tier: "W",
        operations: [
          "isCurrentJournalOwner",
          "listWorkspaceReconciliationOwners",
          "loadWorkspaceReconciliation",
          "createPlacementWorkspaceJournalOps.pruneOrphanedWorkspaceReconciliations",
          "createPlacementWorkspaceJournalOps.beginWorkspaceReconciliation",
          "createPlacementWorkspaceJournalOps.abortWorkspaceReconciliation",
        ],
        evidence:
          "Read dispatch at state-read.worker.ts:653 and journal mutation factory at placement-workspace-journal.worker.ts:30",
      },
      {
        tier: "W",
        operations: ["clearWorkerWorkspaceReconciliation"],
        evidence:
          "Acceptance at placement-turn-claims.worker.ts:190, journal abort via placement-workspace-journal.worker.ts:30 and manifest drain via placement-transitions.worker.ts:82; native move drain supplies no manifest and skips cleanup",
      },
    ],
  ],
  [
    "src/gateway/worker-environments/placement-workspace-result.ts",
    [
      {
        tier: "W",
        operations: ["recordStagedWorkerWorkspaceResult"],
        evidence:
          "Only placement-turn-claims.worker.ts publishes staged results; host callers use async readers and published result facts.",
      },
      {
        tier: "W",
        operations: [
          "hasCurrentWorkspaceResultClaim",
          "clearWorkerWorkspacePendingResult",
          "readWorkerWorkspaceReconciliationFacts",
          "hasWorkerWorkspacePendingResult",
          "hasAcceptedWorkerWorkspacePendingResult",
          "insertWorkerWorkspacePendingResult",
          "listPendingWorkerWorkspaceResultsInDatabase",
          "createPlacementWorkspaceResultOps.acceptWorkspaceResult",
          "assertPendingClaim",
          "createPlacementWorkspaceResultOps.handoffWorkspaceResultRecovery",
          "createPlacementWorkspaceResultOps.abandonWorkspaceResult",
        ],
        evidence:
          "Mutation helpers run through placement turn/lifecycle workers; reconciliation and pending-result reads run in the state read worker. GitHub deferral selection also runs only in state/github-publication.worker.ts. Host exports are async readers or pure row/claim helpers.",
      },
    ],
  ],
  [
    "src/gateway/worker-environments/local-workspace-store.ts",
    [
      {
        tier: "W",
        operations: ["hasLocalWorkspaceProjectionInDatabase"],
        evidence:
          "Only agents/worktrees/registry-retirement.worker.ts:62 calls the retirement predicate",
      },
    ],
  ],
  [
    "src/gateway/worker-environments/prepared-environment-store.ts",
    [
      {
        tier: "W",
        operations: [
          "readPreparedReservations",
          "createPreparedEnvironmentStoreOps.ensurePreparedIntent",
          "createPreparedEnvironmentStoreOps.requestPreparedDestroy",
          "hasPlacementReference",
          "consumePreparedEnvironment",
        ],
        evidence:
          "Prepared mutations run in store.worker.ts; consumption and its placement-reference predicate run only in placement-lifecycle.worker.ts.",
      },
    ],
  ],
  [
    "src/gateway/worker-environments/placement-row-codec.ts",
    [
      {
        tier: "W",
        operations: [
          "find",
          "readWorkerPlacementsForReconcileInDatabase",
          "readWorkerPlacementChangeSnapshotInDatabase",
          "readWorkerPlacementsInDatabase",
          "readWorkerPlacementIdentitiesInDatabase",
        ],
        evidence:
          "State read and placement workers own all row queries; the identity census runs through placement-lifecycle.worker.ts workerPlacements.readIdentities. GitHub deferral selection runs only in state/github-publication.worker.ts. Host consumers use pure row codecs or async/receipt-backed readers.",
      },
      {
        tier: "W",
        operations: ["updateTransition"],
        evidence:
          "Transitions run only in placement-transitions.worker.ts and prepared binding in placement-lifecycle.worker.ts.",
      },
      {
        tier: "W",
        operations: ["ensureLocal"],
        evidence:
          "Dispatch in placement-lifecycle.worker.ts and the placement-turn-claims.ts claim path run in workers; placement-store.ts uses the async worker facade.",
      },
    ],
  ],
  [
    "src/gateway/session-group-catalog.kernel.ts",
    [
      {
        tier: "W",
        operations: [
          "readSessionGroupCatalogSnapshot",
          "readSessionGroupCatalogEntry",
          "updateSidebarOrder",
          "mutateSessionGroupCatalogInDatabase",
        ],
        evidence:
          "Catalog snapshots and mutation commands run in shared-state workers; category destination reads are called only by session-sharing-store.worker.ts after the native category callback was removed",
      },
    ],
  ],
  [
    "src/gateway/github-publication-store.ts",
    [
      {
        tier: "W",
        operations: [
          "listSharedGitHubPublicationsInDatabase",
          "markSharedGitHubPublicationReportedInDatabase",
          "assertSharedGitHubPublicationClaimInDatabase",
          "bindAcceptedGitHubPublicationClaimSnapshotInDatabase",
        ],
        evidence:
          "List is called by state/github-publication.read.worker.ts and github-publication-defer.kernel.ts whose selector only runs in state/github-publication.worker.ts. Report/snapshot are called only by that mutation worker; claim assertion by its snapshot kernel and state/github-publication-request.worker.ts. Native store adapters remain T1.",
      },
    ],
  ],
  [
    "src/gateway/github-repository-publication-store.ts",
    [
      {
        tier: "W",
        operations: [
          "markRepositoryGitHubPublicationReportedInDatabase",
          "failStaleRepositoryGitHubPublicationInDatabase",
        ],
        evidence:
          "Only state/github-publication.worker.ts repositoryMutation report/retire calls these kernels. Native stale-request and reporting adapters retain their separate SQL and T1 classification.",
      },
    ],
  ],
  [
    "src/node-host/node-worker-prepared-workspace-store.kernel.ts",
    [
      {
        tier: "W",
        operations: [
          "selectRow",
          "write",
          "list",
          "register",
          "bind",
          "completeMutation",
          "retire",
        ],
        evidence:
          "List/mutations run only in node-worker-journal.worker.ts:14,19,26,31,36; selectRow/write are mutation-only helpers; native findSync at node-worker-prepared-workspace-store.ts:31 reaches only find, which stays T1",
      },
    ],
  ],
  [
    "src/sessions/session-upstream-links.kernel.ts",
    [
      {
        tier: "W",
        operations: ["listWatchedSessionUpstreamLinksInDatabase"],
        evidence:
          "Only sessionUpstream.listWatched dispatches this read; mutation kernels retain v2026.9.8 synchronous SDK callers until removal after stable deprecation.",
      },
    ],
  ],
  [
    "src/sessions/session-state-events.kernel.ts",
    [
      {
        tier: "W",
        operations: [
          "hasSessionStateWatchersInDatabase",
          "isSessionStateUpstreamCurrentInDatabase",
        ],
        evidence: "session-state-events.worker.ts and session-upstream-links.worker.ts",
      },
      {
        tier: "W",
        operations: [
          "upsertSeedCursor",
          "pruneSessionStateEventsInDatabase",
          "pruneSessionStateEventsInDatabase.stampPrunedWatermarks",
        ],
        evidence:
          "Seed cursors run through sessionState.record/registerWatch; periodic and restart pruning dispatch sessionState.prune",
      },
      {
        tier: "W",
        operations: ["readCursor", "readMaterialCursors", "updateMaterialCursor"],
        evidence:
          "Watch commands and event recording execute only in session-state-events.worker.ts and subagent-registry.store.worker.ts",
      },
      {
        tier: "W",
        operations: ["recordSessionStateEventsInDatabase"],
        evidence:
          "All producers await sessionState.record; the only direct production kernel callers are session-state-events.worker.ts and subagent-registry.store.worker.ts",
      },
    ],
  ],
  [
    "src/sessions/session-state-events.ts",
    [
      {
        tier: "T2",
        operations: ["sweepSessionStateWatchNotices"],
        evidence: "Restart sweep only called by server-startup-observers.ts:58",
      },
    ],
  ],
  [
    "src/skills/library/store.ts",
    [
      {
        tier: "W",
        operations: [
          "ensureSkillLibrarySchema",
          "resolveSkillLibraryActor",
          "requireSelectedSkillLibraryUpload",
          "selectSkillLibraryOwner",
          "selectSkillLibraryEntries",
          "selectSkillLibraryEntries.readOwners",
          "selectSkillLibraryRevision",
          "selectSkillLibraryRevisionMetadata",
          "assertSkillLibraryNameAvailable",
          "recordSkillLibraryEvent",
        ],
        evidence:
          "Library actor, owner, row, revision, upload, and mutation kernels run only through the shared-state reader/writer (read.kernel.ts, service.kernel.ts, import.kernel.ts, and store.worker.ts); readOwners is private to the worker list projection. The SDK metadata batch remains in selection-read.kernel.ts.",
      },
    ],
  ],
  [
    "src/skills/library/selection-read.kernel.ts",
    [
      {
        tier: "W",
        operations: ["selectSkillLibraryRevisionManifestsBatch"],
        evidence:
          "Manifest batch only called by openclaw-state-read.worker.ts:477; metadata batch remains host-reachable",
      },
    ],
  ],
  [
    "src/secrets/store/secret-store-write.ts",
    [
      {
        tier: "W",
        operations: [
          "writeSecretStoreEntriesInDatabase",
          "rollbackSecretStoreEntryWriteInDatabase",
          "deleteSecretStoreEntryInDatabase",
          "updateSecretStoreAllowedHostsInDatabase",
        ],
        evidence:
          "Only secretStoreOperations in secret-store.worker.ts calls these ordinary secret mutation kernels",
      },
    ],
  ],
  [
    "src/cron/store/run-receipt-store.ts",
    [
      {
        tier: "W",
        operations: [
          "activeRow.find",
          "pruneTerminalReceipts",
          "adjudicateActiveCronRunReceiptInDatabase",
          "claimCronRunReceiptInDatabase",
          "activateCronRunReceiptInDatabase",
          "finishCronRunReceiptInDatabase",
        ],
        evidence:
          "Admission/recovery/reservation/state/maintenance/dispatch workers own direct primitives; service message guards consume receipt-authority-owner facts without the deleted native current-job reader",
      },
    ],
  ],
  [
    "src/cron/store/run-receipt-read.ts",
    [
      {
        tier: "W",
        operations: ["readActiveCronRunReceiptsInDatabase"],
        evidence:
          "read-command.ts currentReceipt and run-recovery.read.ts route through openclaw-state-read.worker.ts; remaining direct callers are run-admission.worker.ts and runtime-maintenance.worker.ts",
      },
    ],
  ],
  [
    "src/cron/store/row-codec.ts",
    [
      {
        tier: "T3",
        operations: [
          "loadCronRows",
          "readCronJobsFingerprint",
          "replaceCronRows",
          "upsertCronJobRow",
          "deleteCronJobRowInDatabase",
          "revokeCronJobStandingGrants",
          "readMaximumRetainedGrantDefinitionGeneration",
        ],
        evidence:
          "Cron worker kernels or Doctor legacy-repair.ts:395 transactionHooks / store-repair.ts:178 / doctor-heartbeat-task-migration.ts:261,308. Retained grant generations are read by worker upsert or resolveCronJobGrantDefinitionGenerationFloor for commands/doctor/cron/store-repair.ts only.",
      },
      {
        tier: "W",
        operations: ["deleteStaleCronJobFamilyRows", "updateCronRuntimeRow"],
        evidence:
          "run-admission.worker.ts:458 and worker runtime-state saves; Doctor never requests stateOnly saves",
      },
    ],
  ],
  [
    "src/agents/workspace-state-store.kernel.ts",
    [
      {
        tier: "T2",
        operations: [
          "registerWorkspaceStateAliasIdentitiesInTransaction",
          "readWorkspaceStateSnapshotFromDatabase",
          "resolveWorkspaceIdentityFromDatabase",
        ],
        evidence:
          "Workspace worker/read dispatch plus Doctor alias rebind, workspace setup migration, and relocation retirement; native identity resolution remains only with those maintenance callers",
      },
      {
        tier: "W",
        operations: ["replaceWorkspaceAttestationInDatabase", "deleteWorkspaceStateRowsInDatabase"],
        evidence:
          "workspace.replaceAttestation, workspace.expire and workspace.delete dispatch in the shared-state worker; shared snapshot/alias helpers retain Doctor/migration exposure",
      },
    ],
  ],
  [
    "src/agents/plugin-model-catalog.ts",
    [
      {
        tier: "T2",
        operations: [
          "repairPersistedPluginModelCatalogs",
          "replacePersistedPluginModelCatalogEntries",
          "retireCommittedPluginModelCatalogMigration",
        ],
        evidence:
          "Only doctor-plugin-model-catalog.ts:103,126 reaches repair/import/receipt retirement; runtime replacement dispatches at plugin-model-catalog.ts:584; ModelRegistry synchronous kernel reads stay T1",
      },
    ],
  ],
  [
    "src/state/user-preferences.store.ts",
    [
      {
        tier: "W",
        operations: [
          "readUserPreferences",
          "writeUserPreferences",
          "deleteUserPreference",
          "selectUserPreferenceValues",
          "readPreferenceKeys",
          "mergeUserPreferences",
        ],
        evidence:
          "Preference read/write dispatch at user-preferences.worker.ts:52,74; merge/GitHub helpers only in user-profile-writes.worker.ts:375,425,482 and openclaw-state-read.worker.ts:616; private key scans serve these worker writers",
      },
    ],
  ],
  [
    "src/state/user-profile-identity.read.ts",
    [
      {
        tier: "W",
        operations: ["readUserProfileEmailBindings", "readUserProfileSnapshotSync"],
        evidence:
          "Registered profile writers and openclaw-state-read.worker.ts execute these readers. Full-profile and project-alias reads use the committed catalog. Released SDK identity/display fallbacks retain native reads.",
      },
    ],
  ],
  [
    "src/state/agent-deletion-journal.ts",
    [
      {
        tier: "T2",
        operations: ["readAgentDeletionPathFenceRows"],
        binding: "rows",
        evidence:
          "Native SQL is limited to openclaw-agent-db lease/schema/registry admission and Doctor journal restore/quarantine. Agent event guards without an explicit database consume published owner facts. Explicit-database deletion/recovery and Cron availability callers execute in their existing workers.",
      },
      {
        tier: "W",
        operations: [
          "beginAgentDeletionJournalInDatabase",
          "updateAgentDeletionJournalPathsInDatabase",
          "handoffAgentDeletionJournalInDatabase",
          "completeAgentDeletionJournalInDatabase",
          "deleteAgentDeletionJournalInDatabase",
        ],
        evidence:
          "agent-deletion.worker.ts owns all production journal mutations; synchronous fixture adapters live under test-utils. Native SDK cleanup retains only live journal/lease reads around agent COMMIT",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-archive-read.ts",
    [
      {
        tier: "W",
        operations: [
          "readTranscriptArchivePresenceInWorker",
          "readTranscriptArchiveFinalInWorker",
          "readTranscriptArchivePageInWorker",
        ],
        evidence:
          "Only session-transcript.worker.ts:230 (presence) and session-accessor.sqlite-archive.worker.ts:483,491 (page/final) call these readers; shared archive listing remains T1.",
      },
      {
        tier: "T1",
        operations: ["listTranscriptArchivesFromDatabase"],
        evidence:
          "Durable archive enumeration reaches this query through transcript, Memory corpus, and usage-cost workers. session-transcript-inventory-runtime.ts returns an empty archive inventory for memory actors. Synchronous history/SDK readers retain the shared durable kernel. The shared list kernel remains mixed.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-canonical-inventory.ts",
    [
      {
        tier: "T3",
        operations: [
          "listCanonicalSessionRepairFacts",
          "loadCanonicalSessionRepairEntries",
          "scanDoctorSessionEntriesStrict",
          "scanDoctorSessionEntriesTolerant",
        ],
        evidence:
          "Doctor callers only: commands/doctor-session-canonical-candidates.ts:94; doctor-session-canonical-keys.ts:132; doctor-state-integrity.ts:1280; doctor-session-title-repair.ts:118; doctor-session-delivery-state.ts:112; doctor/shared/codex-route-session-repair.ts:551,552.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-entry-availability.ts",
    [
      {
        tier: "T3",
        operations: ["loadExactSessionEntryReadOnlyResult"],
        evidence:
          "Only acp/runtime/session-meta-doctor.ts calls this availability probe, from repairAcpSessionMetaKeysForDoctor and readClaimBinding for plugin Doctor claim inspection. Identity evidence has separate worker/Doctor ownership.",
      },
      {
        tier: "T3",
        operations: [
          "readSessionIdentityEvidenceBatch",
          "readSessionIdentityEvidenceInDatabase.readChunks",
        ],
        evidence:
          "state-migrations.plugin-doctor-context.ts is the only native batch caller, through its async Doctor context method. The in-database reader also serves session-history-read-operation.worker.ts; no ordinary Gateway native caller remains.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-entry-list.read.ts",
    [
      {
        tier: "W",
        operations: ["listSqliteSessionEntriesFromDatabase"],
        binding: "rows",
        evidence:
          "Only session-entry-read-runtime.ts:458,488 produces cronRetention/expiredCronRuns through withSessionStoreReaderInWorker; session-entry-read.worker.ts:166 calls listSessionEntriesReadOnly. Other native list callers omit both selectors; only the rows initializer is worker-only.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-generation-copy.ts",
    [
      {
        tier: "T2",
        operations: [
          "copySqliteSessionGenerationRows",
          "readSqliteSessionGenerationWindows",
          "readSqliteSessionGenerationFacts",
        ],
        evidence:
          "Comparison reads run in session-retirement-read.worker.ts; full claims and generation copies are Doctor legacy/canonical repair. Native deletion-plan generation reads require expectedGenerations, supplied only by legacy-main-session-migration-operations.ts",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-import.ts",
    [
      {
        tier: "T2",
        operations: ["importSqliteSessionRowsInTransaction", "importSqliteSessionRowsBatch"],
        evidence:
          "Legacy session migration: commands/doctor-session-sqlite-import.ts:84 and doctor-session-sqlite-active.ts:73; Doctor retained recovery at doctor-session-sqlite-retained.ts:197 -> infra/deferred-plugin-session-sources.ts:541,590 -> deferred-plugin-session-verification.ts:92 -> deferred-plugin-session-empty.ts:78.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-node-artifacts.ts",
    [
      {
        tier: "T3",
        operations: ["clearSessionCollaborationForKey", "readSessionNodeArtifactTables"],
        evidence:
          "Collaboration clear runs only when entry-write.ts replaces a canonical sessionId. Those writes use reset/replacement/message-cut/fork/recovery workers or Doctor; native transcript/compaction compatibility preserves identity. Archive batching retains the same sessionId and cannot enter this branch. Catalog fallback additionally serves repair/copy/delete/fingerprint kernels already classified as maintenance; admitted schema facts bypass it for normal handles.",
      },
      {
        tier: "T2",
        operations: ["deleteSessionMembersForRepair", "readSessionNodeArtifactFingerprint"],
        evidence:
          "Member cleanup is Doctor canonical repair. Full readClaim is Doctor-only; deletion-plan fingerprint reads require expectedNodeArtifactFingerprint, supplied only by Doctor deleteExpectedClaim. Worker detection omits artifact custody; other native artifact kernels remain separately classified",
      },
      {
        tier: "T3",
        operations: [
          "copySessionNodeArtifactsForRepair",
          "deleteSessionDeliveryArtifacts",
          "deleteSessionNodeArtifacts",
        ],
        evidence:
          "Copy callers are entry-store legacy alias rehome, Doctor canonical-key repair, Doctor-only canonical-repair aliases and legacy migration guarded by doctor-fix. Alias rehome uses worker/maintenance lifecycle or replacement commits. Node deletion is called only by entry deletion; delivery deletion additionally serves reclamation. These deletion roots are worker/maintenance kernels or cleanup-utils.ts offline reset.",
      },
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-pending-inputs-repair.ts",
    [
      {
        tier: "T2",
        operations: ["copySessionInputCompletionsForRepair"],
        binding: "existing",
        evidence:
          "node-artifacts.ts:151 is shared, but entry-store.ts:372 runtime alias moves pass the same database and return at pending-inputs-repair.ts:130. The existing initializer is cross-database Doctor repair only, via canonical-repair.ts:514,521 and legacy-main-session-migration-operations.ts:343.",
      },
      {
        tier: "T3",
        operations: ["copySessionPendingInputsForRepair", "copySessionInputCompletionsForRepair"],
        evidence:
          "Both copy helpers are called only by copySessionNodeArtifactsForRepair: worker/maintenance alias rehome, Doctor canonical repair and legacy migration guarded by doctor-fix. The cross-database completion lookup retains its narrower Doctor-only classification.",
      },
    ],
  ],
  [
    "src/config/sessions/session-canonical-key-read.ts",
    [
      {
        tier: "T2",
        operations: ["isCanonicalSqliteSessionMainKeyCurrent"],
        evidence:
          "Only startup-migration.ts:287 calls it, through gateway/server-startup-session-migration.ts:201 and server-startup-plugins.ts:99 or deferred boot admission at server-agent-database-startup.ts:112.",
      },
    ],
  ],
  [
    "src/config/sessions/session-canonical-key.ts",
    [
      {
        tier: "T2",
        operations: ["setCanonicalSqliteSessionMainKey", "markCanonicalSessionValidationPending"],
        evidence:
          "The setter serves startup-migration.ts boot admission and commands/doctor-session-canonical-keys.ts repair. Pending validation is written only by that setter or explicit allowStoredAlias(s)/allowCanonicalRepair imports and repairs: legacy-main-session-migration-operations.ts, session-accessor.sqlite-import.ts, and Doctor projection/rewrite. Import's retained recovery path is Doctor-only via doctor-session-sqlite-retained.ts -> rebuildDeferredPluginSessionSourceIndex.",
      },
    ],
  ],
  [
    "src/config/sessions/session-canonical-validation.ts",
    [
      {
        tier: "W",
        operations: [
          "seedCanonicalSessionValidation",
          "readPendingCanonicalSessionValidationBatch",
          "compareAndCertifyCanonicalSessionValidationBatch",
          "hasPendingCanonicalSessionValidation",
        ],
        evidence:
          "Only session-accessor.sqlite-mutation-worker.runtime.ts calls these operations in the mutation-worker message handler. Startup and Doctor readiness trust the canonical-validation receipt instead of probing pending rows.",
      },
    ],
  ],
  [
    "src/config/sessions/session-cold-storage-backup.worker.ts",
    [
      {
        tier: "W",
        operations: ["embedSessionColdArchivesInSnapshotInWorker"],
        evidence:
          "Only session-accessor.sqlite-archive.worker.ts cold-embed-snapshot dispatch and snapshot/database-backup-core.worker.ts PostgreSQL export call this kernel. The host facade awaits the existing archive worker, including the public SDK deleteSessionEntry backupDir path; SQL targets the retained private snapshot.",
      },
    ],
  ],
  [
    "src/gateway/github-personal-publication-store.ts",
    [
      {
        tier: "W",
        operations: [
          "requirePersonalGitHubPublicationConfirmationInDatabase",
          "markPersonalGitHubPublicationReportedInDatabase",
        ],
        evidence:
          "Only state/github-publication.worker.ts personalMutation restart/report calls these kernels. Native confirmation and reporting adapters retain their separate SQL and existing classification.",
      },
      {
        tier: "T2",
        operations: ["requirePersonalGitHubPublicationConfirmation"],
        evidence:
          "Only github-publication-runtime.ts:18 during construction by server-worker-placement-startup.ts:90, reached from server-runtime-state-prepare.ts:181. Periodic reconcilePublications never calls the fence.",
      },
    ],
  ],
  [
    "src/gateway/worker-environments/placement-drain.ts",
    [
      {
        tier: "W",
        operations: ["drainWorkerSessionPlacement"],
        evidence:
          "Only placement turn/transition workers and the move mutation kernel in placement-lifecycle.worker.ts drain placements.",
      },
    ],
  ],
  [
    "src/gateway/worker-environments/placement-retirement.ts",
    [
      {
        tier: "W",
        operations: ["retireWorkerSessionPlacement"],
        evidence:
          "Only placement-lifecycle.worker.ts retires placement rows; host placement APIs dispatch through the lifecycle worker.",
      },
    ],
  ],
  [
    "src/gateway/worker-environments/placement-workspace-reservation.kernel.ts",
    [
      {
        tier: "W",
        operations: ["assertSessionWorkspaceUnreserved"],
        evidence:
          "Only placement-lifecycle.worker.ts and worker-owned claim kernels check the reservation before the effect; host preparation uses worker reads.",
      },
    ],
  ],
  [
    "extensions/memory-core/src/memory-session-tombstones.ts",
    [
      {
        tier: "W",
        operations: ["recordMemorySessionTombstonesInDatabase", "readMemorySessionTombstones"],
        evidence:
          "memory-entry-origins.worker.ts -> memory-forget-kernel.ts owns tombstone writes; origin reads and publication workers consume live tombstones. Direct source/cache publication checks the live owner, while private shadow cutover rejects a changed published revision; no per-session shadow preflight remains.",
      },
    ],
  ],
  [
    "extensions/memory-core/src/memory/manager-source-state.ts",
    [
      {
        tier: "W",
        operations: ["loadMemorySourceFileState", "refreshMemorySessionSourceState"],
        evidence:
          "manager-publication.worker.ts source.state and manager-search.worker.ts source-state/recall-metadata are the only runtime callers. Source synchronization and inspection await MemoryIndexDatabase.readSourceState; the kernel remains directly callable only by isolated tests.",
      },
    ],
  ],
  [
    "extensions/memory-core/src/memory/manager-status-state.ts",
    [
      {
        tier: "T3",
        operations: ["collectMemoryStorageStatus"],
        evidence:
          "Only collectMemoryStatusSnapshot calls the storage query, gated by includeStorage from sourceInspections populated through inspectSources. manager-search.worker.ts serves statusAsync; retained synchronous status uses the same snapshot. CLI status/index/search and commands/status.scan.shared.ts request diagnostic inspection; ordinary Gateway status does not.",
      },
    ],
  ],
  [
    "src/agents/harness/native-hook-relay-bridge-query.ts",
    [
      {
        tier: "T3",
        operations: ["readNativeHookRelayBridgeRow"],
        evidence:
          "Native Node one-shot CLI: src/cli/native-hook-relay-cli.ts:98 -> native-hook-relay-client.ts:39 -> native-hook-relay-client-store.ts:20 -> native-hook-relay-client-read.ts:22. Gateway reads/mutations use native-hook-relay-store.worker.ts:11,35,44,53 through store.kernel.ts:48; Bun CLI uses its client worker.",
      },
    ],
  ],
  [
    "src/agents/plugin-model-catalog.kernel.ts",
    [
      {
        tier: "T2",
        operations: [
          "replacePluginModelCatalogEntriesInDatabase",
          "replacePluginModelCatalogEntriesInDatabase.upsertCacheEntry",
        ],
        evidence:
          "Native replacement is Doctor import only: src/commands/doctor-plugin-model-catalog.ts:103 -> plugin-model-catalog.ts:495,517 -> :162. The other caller is plugin-model-catalog.worker.ts:94; readPluginModelCatalogEntries remains T1.",
      },
    ],
  ],
  [
    "src/agents/sandbox/registry.kernel.ts",
    [
      {
        tier: "W",
        operations: [
          "removeRegistryRowInDatabase",
          "insertSandboxRegistryRowInDatabase",
          "insertSandboxRegistryRowIfMissingInDatabase",
          "readRegistryRows",
          "readSandboxRegistryRowInDatabase",
        ],
        evidence:
          "Registry mutations, including reservation and removal-intent selection, run only through sandboxRegistryOperations in registry-write.worker.ts; insertIfMissing delegates to registry-import.worker.ts. Read helpers run through openclaw-state-read-handlers.ts in the read worker. Synchronous sandbox effect checks consume registry-currentness.ts facts maintained by committed receipts.",
      },
    ],
  ],
  [
    "src/agents/subagents/registry/subagent-registry.store.kernel.ts",
    [
      {
        tier: "W",
        operations: ["writeSubagentRunValuesInDatabase"],
        evidence:
          "Registry persistence and completion admission workers invoke the batch write kernel after the host FIFO owner plans from committed receipts. Completion mutation writes are reached only through the admission worker; no native writer caller remains.",
      },
    ],
  ],
  [
    "src/agents/subagents/registry/subagent-registry.store.sqlite.ts",
    [
      {
        tier: "W",
        operations: [
          "readSubagentRunRow",
          "readSubagentSessionListRows",
          "readSubagentRegistryRows",
          "loadSubagentRunsForSessionsInDatabase",
        ],
        evidence:
          "Exact rows serve completion admission workers. Session-list and child reads serve openclaw-state-read.worker.ts. Registry rows serve store.worker.ts maintenance/versioned/session reads or completion-mutation.kernel.ts through completion-admission.worker.ts. Descendant selection is called only by store.worker.ts; the native digest comparison has been removed.",
      },
    ],
  ],
  [
    "src/agents/workspace-alias-rebind.ts",
    [
      {
        tier: "T2",
        operations: [
          "readWorkspaceMoveState",
          "detectRepointedWorkspaceAlias",
          "rebindRepointedWorkspaceAlias",
        ],
        evidence:
          "Only src/commands/doctor-workspace-alias.ts:67,107,131 invokes detect/rebind; readWorkspaceMoveState is private at :166,282. Doctor health/lint reaches detection and reporting via doctor:workspace-alias in src/flows/doctor-health-contributions-final.ts; repair is installed by src/commands/doctor-config-flow.ts:83,93.",
      },
    ],
  ],
  [
    "src/agents/worktrees/registry-read.kernel.ts",
    [
      {
        tier: "W",
        operations: [
          "getRegistryWorktreeInDatabase",
          "findLiveRegistryWorktreeByOwnerInDatabase",
          "findLiveRegistryWorktreeByPathInDatabase",
          "listRegistryWorktreesInDatabase",
          "readProvisionedData",
          "listLiveRegistryWorktreeIdsInDatabase",
          "listExistingLiveWorktreePathsInDatabase",
          "getRegistryWorktreeProvisionedChunkInDatabase",
        ],
        evidence:
          "Runtime reads and exact-row predicates use worktrees/dispatch.worker.ts and registry-run-end.worker.ts through the shared-state worker registry. Cleanup inventory uses openclaw-state-read-handlers.ts in the read worker. Live-path discovery is private to worktreeReadOperations, loaded by openclaw-state-read-operation-registry.ts and executed by openclaw-state-read.worker.ts. Native fixture readers live only in registry.test-support.ts; Doctor migration lists keep their separate registry.ts queries.",
      },
    ],
  ],
  [
    "src/agents/worktrees/registry.ts",
    [
      {
        tier: "T2",
        operations: ["createWorktreeRemovalClaimsGuard", "releaseWorktreeRunLeaseRow"],
        evidence:
          "Synchronous removal-lock assertion immediately before filesystem/Git deletion and process-exit lock cleanup. Ordinary cleanup consumes the existing worker lease census.",
      },
      {
        tier: "T2",
        operations: [
          "listRegistryWorktreesForMigration",
          "rewriteRegistryWorktreePathsForMigration",
          "runRegistryMigration",
        ],
        evidence:
          "Only migration discovery src/infra/state-migrations.doctor-discovery.ts:84 and Doctor repair src/config/sessions/worktree-workspace-migration.ts:116 call the list; the latter requires doctor-fix mode. The private runRegistryMigration transaction is called only by discardLegacyRegistryWorktrees and rewriteRegistryWorktreePathsForMigration; their sole production caller is the managed-worktrees step at src/infra/state-migrations.doctor.ts:1256,1258 (Doctor/startup). It acquires the existing schema-maintenance owner before opening the transaction database.",
      },
      {
        tier: "T3",
        operations: ["listLegacyRegistryWorktreesForMigration", "discardLegacyRegistryWorktrees"],
        evidence:
          "Legacy list is only src/infra/state-migrations.doctor-discovery.ts:52 under doctorOnlyStateMigrations === true (:51); discard is only state-migrations.doctor.ts:1360 under isDoctor (:1359). Ordinary runtime worktree readers and mutations remain T1.",
      },
    ],
  ],
  [
    "src/agents/worktrees/run-lease-owner.ts",
    [
      {
        tier: "T2",
        operations: ["collectLiveRunLeases"],
        evidence:
          "Native caller is registry.ts assertWorktreeRemovalAvailable, a removal lock primitive; ordinary runtime lease reads and writes dispatch through shared-state workers.",
      },
      {
        tier: "W",
        operations: ["readWorktreeRunLeaseStateInDatabase", "assertRegistryMutationCustody"],
        evidence:
          "Run-lease inventory is dispatched by openclaw-state-read-handlers.ts in the read worker. Registry mutation custody is called only by registry-run-end.worker.ts. The actual lease read/reap primitives remain synchronous exemptions.",
      },
    ],
  ],
  [
    "src/agents/worktrees/run-lease-store.kernel.ts",
    [
      {
        tier: "T2",
        operations: ["releaseWorktreeRunLeaseInDatabase"],
        evidence:
          "Native invocation is registry.ts process-exit lock cleanup; normal release dispatches through worktrees/dispatch.worker.ts.",
      },
      {
        tier: "W",
        operations: ["admitWorktreeRunLeaseInDatabase", "readCurrentWorktreeRunState"],
        evidence:
          "worktrees/dispatch.worker.ts owns run admission. Persistent execution reaches the shared worktree check only through local-workspace-store.kernel.ts and stream-source-admission.ts from persistent-exec-store.worker.ts. Native exit cleanup calls only releaseWorktreeRunLeaseInDatabase and remains a separate lock primitive.",
      },
    ],
  ],
  [
    "src/plugin-state/plugin-state-store.kernel.ts",
    [
      {
        tier: "T2",
        operations: ["selectPluginStateEntriesInKeyRange"],
        evidence:
          "Native raw-row inspection only: src/infra/state-migrations.plugin-doctor-context.ts:416 -> plugin-state-store.sqlite.ts:394. Other callers are plugin-state.worker.ts:104 -> plugin-state-store.reads.ts:111 and plugin-state.worker.ts:173 -> plugin-state-store.journal.ts:122; public key-range facade is asynchronous at plugin-state-store.ts:580.",
      },
      {
        tier: "W",
        operations: ["allocatePluginStateNamespaceCreatedAt"],
        evidence:
          "Only plugin-state-store.journal.ts:202 calls allocation, and only plugin-state.worker.ts:173 calls that journal kernel; host facade plugin-state-store.ts:555 dispatches registerPluginStateJournalInWorker.",
      },
    ],
  ],
  [
    "src/plugin-state/plugin-state-store.retention.ts",
    [
      {
        tier: "T2",
        operations: ["readPluginStateRetention"],
        evidence:
          "Only migration/Doctor batch creates retention: src/infra/state-migrations.plugin-doctor-context.ts:409 -> plugin-state-store.ts:597 -> plugin-state-store.sqlite.ts:133,139. The conditional retention refresh at plugin-state-store.retention.ts:228 shares that batch; native ordinary registration (:107) and worker registration (plugin-state.worker.ts:190) omit retention.",
      },
    ],
  ],
  [
    "src/plugin-state/plugin-state-store.sqlite.ts",
    [
      {
        tier: "T2",
        operations: ["pluginStateDeleteEntriesIfUnchanged"],
        evidence:
          "Only src/infra/state-migrations.plugin-doctor-context.ts:466 calls exact-row deletion, after repair-authority validation at :464. Context creation is limited to state-migrations.plugin-doctor.ts:200,325; no runtime keyed-store method exposes this repair operation.",
      },
    ],
  ],
  [
    "packages/memory-host-sdk/src/host/memory-recall-metadata.ts",
    [
      {
        tier: "W",
        operations: ["readCuratedCandidateBatch", "readMemoryRecallMetadata"],
        evidence:
          "extensions/memory-core/src/memory/manager-search.worker.ts owns curated and recall-metadata reads, including fused session-only keyword requests. The private-local-only memory-core-host-engine-storage facade only re-exports kernels; no host runtime reader remains.",
      },
    ],
  ],
  [
    "src/acp/runtime/session-meta-doctor.ts",
    [
      {
        tier: "T3",
        operations: [
          "repairAcpSessionMetaKeysForDoctor",
          "repairAcpSessionMetaKeysForDoctor.validate",
          "inspectAcpSessionClaimsForDoctor",
          "updateAcpSessionIdentityForDoctor",
        ],
        evidence:
          "Doctor repair, including the synchronous createVerifiedSqliteSnapshot validation callback: src/commands/doctor-session-transcripts.ts:318. Plugin Doctor context: src/infra/state-migrations.plugin-doctor-context.ts:403,463, constructed by state-migrations.plugin-doctor.ts:200,325.",
      },
    ],
  ],
  [
    "src/acp/runtime/session-meta-keys.ts",
    [
      {
        tier: "W",
        operations: ["selectAcpSessionRows", "selectAcpSessionRowsByKeys"],
        evidence:
          "session-meta-list.ts submits acpSessions.list to the shared read worker. Batched exact-key reads are called only by session-meta-read.worker.ts; ordinary bundled entry readers await that worker and the deprecated synchronous SDK reader uses its separate single-row operation.",
      },
      {
        tier: "T3",
        operations: ["upsertAcpSessionMetaRow", "deleteAcpSessionMetaRows"],
        evidence:
          "Mutators serve the worker kernel, exclusive-maintenance session-meta-write.native.ts, Doctor repair, and the offline migration writer. Ordinary Gateway writes use workers; selectAcpSessionRow retains its separate synchronous SDK classification.",
      },
    ],
  ],
  [
    "src/acp/runtime/session-meta.ts",
    [
      {
        tier: "T2",
        operations: ["writeAcpSessionMetaForMigration"],
        evidence:
          "The native writer is retained only by src/infra/state-migrations.acp-session-metadata.ts and test fixtures. Gateway reset rebinding uses session-meta-reset.ts -> commitAcpSessionMutation in the shared-state worker; synchronous SDK readers retain their separate native classification.",
      },
    ],
  ],
  [
    "src/templates/cron.ts",
    [
      {
        tier: "T3",
        operations: ["persistPendingRef", "updateRef", "deleteClawCronRef", "upsertClawCronRef"],
        evidence:
          "CLI add/update/remove only: src/cli/templates-cli.ts:115,152,181 → add.ts:585, update-apply.ts:541 and lifecycle-state.ts:555,557 → cron.ts/cron-update.ts.",
      },
    ],
  ],
  [
    "src/templates/lifecycle-config-removal.ts",
    [
      {
        tier: "T3",
        operations: ["withClawAgentConfigRemoval"],
        evidence:
          "src/cli/templates-cli.runtime.ts:562 invokes removal → src/templates/lifecycle-state.ts:489 (sole caller).",
      },
    ],
  ],
  [
    "src/templates/lifecycle-delete-support.ts",
    [
      {
        tier: "T3",
        operations: ["releaseClawRemoveRows"],
        evidence:
          "src/cli/templates-cli.runtime.ts:562 invokes removal → src/templates/lifecycle-state.ts:650 (sole caller).",
      },
    ],
  ],
  [
    "src/templates/mcp.ts",
    [
      {
        tier: "T3",
        operations: [
          "persistPendingRef",
          "updateRef",
          "deleteClawMcpServerRef",
          "upsertClawMcpServerRef",
        ],
        evidence:
          "CLI add/update/remove only: src/cli/templates-cli.ts:115,152,181 → add.ts:568,570, update-apply.ts:410 and lifecycle-state.ts:506 → mcp.ts/mcp-update.ts/lifecycle-mcp-removal.ts.",
      },
    ],
  ],
  [
    "src/templates/package-update-provenance.ts",
    [
      {
        tier: "T3",
        operations: ["replaceClawPackageRefExpected"],
        evidence:
          "CLI update: src/cli/templates-update-cli.runtime.ts:175 → src/templates/update-apply.ts:300,322 → package-update.ts:59,98,99,182,183,228,234,254.",
      },
    ],
  ],
  [
    "src/templates/workspace.ts",
    [
      {
        tier: "T3",
        operations: [
          "persistWorkspaceFile",
          "readWorkspaceFile",
          "updateWorkspaceFileStatus",
          "upsertClawWorkspaceFile",
          "deleteClawWorkspaceFileRecord",
        ],
        evidence:
          "CLI add: src/templates/add.ts:509,511 → workspace.ts:376,408,417,419,427,432; CLI update: update-apply.ts:398 → workspace-update.ts:115,121,171,173,177.",
      },
    ],
  ],
  [
    "src/cron/scratch-read.kernel.ts",
    [
      {
        tier: "T3",
        operations: ["readScratchStateFromDatabase"],
        evidence:
          "Native maintenance reads: Doctor scratch migration, task scratch, and scratch preflight call readScratchStateFromDatabase, directly or through scratch-store.ts.",
      },
      {
        tier: "W",
        operations: [
          "readCronScratchSnapshotInDatabase",
          "readHeartbeatMonitorScratchFromDatabase",
        ],
        evidence:
          "Only cron/store/read-command.ts calls the snapshot through openclaw-state-read-handlers.ts in openclaw-state-read.worker.ts. The private heartbeat reader is called only by that snapshot; host callers dispatch cron.scratch through scratch-read.ts.",
      },
    ],
  ],
  [
    "src/cron/scratch-write.kernel.ts",
    [
      {
        tier: "T3",
        operations: ["writeCronJobScratchInDatabase"],
        evidence:
          "Doctor scratch migration calls writeCronJobScratchInDatabase inside its existing transaction; runtime writes enter through src/cron/store/scratch.worker.ts. Synchronous fixture maintenance lives in test/helpers/cron/scratch-store.ts.",
      },
    ],
  ],
  [
    "src/infra/deferred-plugin-session-sources.ts",
    [
      {
        tier: "T2",
        operations: [
          "rebuildDeferredPluginSessionSourceIndex",
          "recordDeferredPluginSessionImport",
        ],
        evidence:
          "Doctor retained-source recovery/import: src/commands/doctor-session-sqlite-retained.ts:197 and doctor-session-sqlite.ts:376,1039.",
      },
    ],
  ],
  [
    "src/infra/delivery-queue-sqlite-bound.ts",
    [
      {
        tier: "T2",
        operations: [
          "terminalizeBoundDeliveryQueueEntry",
          "pruneOrdinaryDeliveryReceipts",
          "pruneDeliveryQueueTombstones",
        ],
        evidence:
          "Native migration: src/infra/outbound/delivery-queue-migration.ts:308; schema backfill: src/state/openclaw-state-db-delivery-queue-backfill.ts:93. Bounded pruning also serves native namespace migration through delivery-queue-sqlite.kernel.ts:192. Other terminalization/pruning callers are delivery-queue.worker.ts:117,316,387,457 and session-delivery-queue.worker.ts:264.",
      },
      {
        tier: "W",
        operations: ["pruneDeliveryQueueTombstoneAges"],
        evidence:
          "Sole runtime caller: src/infra/delivery-queue.worker.ts:480 → delivery-queue-sqlite.kernel.ts:409.",
      },
    ],
  ],
  [
    "src/infra/delivery-queue-sqlite-namespace.kernel.ts",
    [
      {
        tier: "W",
        operations: ["commitStagedDeliveryQueueEntryOnceAcrossNamespacesInDatabase"],
        evidence:
          "src/infra/outbound/delivery-queue-enqueue.worker.ts:95; registered dispatch src/infra/delivery-queue.worker.ts:445.",
      },
      {
        tier: "T2",
        operations: ["loadPendingDeliveryQueueRow"],
        evidence:
          "Native replace/move: src/infra/delivery-queue-sqlite-namespace.ts:34,49 → outbound/delivery-queue-migration.ts:169,205,235,289,349,367,435. Other callers are enqueue/delivery workers.",
      },
    ],
  ],
  [
    "src/infra/delivery-queue-sqlite-namespace.ts",
    [
      {
        tier: "T2",
        operations: ["replacePendingDeliveryQueueEntry", "movePendingDeliveryQueueEntryNamespace"],
        evidence:
          "Sole native callers src/infra/outbound/delivery-queue-migration.ts:169,205,235,289,349,367,435; Doctor entry src/commands/doctor-outbound-delivery.ts:137,162.",
      },
    ],
  ],
  [
    "src/infra/delivery-queue-sqlite.kernel.ts",
    [
      {
        tier: "W",
        operations: [
          "expireStagingAndLoadDeliveryQueueEntriesInDatabase",
          "countFailedDeliveryQueueEntriesInDatabase",
          "inspectDeliveryQueueReceiptInDatabase",
        ],
        evidence:
          "Expiry snapshot: src/infra/delivery-queue.worker.ts:487 → outbound/delivery-queue-media-staging.kernel.ts:74. Failed count: delivery-queue.worker.ts:455.",
      },
      {
        tier: "T2",
        operations: [
          "loadDeliveryQueueEntriesInDatabase",
          "deleteDeliveryQueueEntryInDatabase",
          "countPendingDeliveryQueueEntriesInDatabase",
          "selectDeliveryQueueEntryOwners.readExact.readChunk",
        ],
        evidence:
          "Native loads/deletes/count and receipt ownership serve Doctor migration via commands/doctor-outbound-delivery.ts and infra/outbound/delivery-queue-migration.ts. Post-ready recovery count and cron receipt selection use delivery-queue.worker.ts; test-only status inspection lives in test support. Initial post-ready recovery is not boot admission.",
      },
    ],
  ],
  [
    "src/infra/device-identity-store.ts",
    [
      {
        tier: "T2",
        operations: [
          "readStoredIdentityRowFromDatabase",
          "isEmptyBootstrapIdentityTableMiss",
          "insertStoredDeviceIdentityIfAbsent",
        ],
        evidence:
          "Live callers use device-identity-async.ts through openclaw-state.worker.ts. Native callers are startup-local-cli-pairing.ts (server-runtime-state-prepare boot), node-host/runner.ts and startup-state-readiness.ts (node boot/connect CLI), config-preflight-snapshot.ts, doctor-device-pairing.ts, doctor-heartbeat-schedule.ts (Doctor cadence migration only), and state-migrations.device-identity*.ts (Doctor).",
      },
      {
        tier: "T2",
        operations: ["repairInvalidStoredDeviceIdentity"],
        evidence:
          "src/infra/state-migrations.device-identity.ts:475 enforces doctorOnlyStateMigrations, then :494 → state-migrations.device-identity-repair.ts:64.",
      },
    ],
  ],
  [
    "src/infra/exec-approvals-sqlite.ts",
    [
      {
        tier: "T2",
        operations: ["assertExecApprovalsMutationAllowed", "writeExecApprovalsConfigRow"],
        evidence:
          "Runtime policy writes and mutation guards run in exec-approvals-mutation.worker.ts, exec-approvals-authorization.worker.ts, exec-approvals-retirement.worker.ts and operator-approval-store.transitions.worker.ts via mintMcpToolGrantLocked. Native callers are updateExecApprovalsForMaintenance via exec-approvals-generated-migration.ts (Doctor), and state-migrations.exec-approvals{,-canonical}.ts. The shared synchronous policy reader remains T1.",
      },
      {
        tier: "W",
        operations: ["deleteExecApprovalsConfigRow"],
        evidence:
          "exec-approvals-mutation.worker.ts restores an absent policy row through the shared-state writer.",
      },
    ],
  ],
  [
    "src/infra/exec-approvals-store.ts",
    [
      {
        tier: "T2",
        operations: ["updateExecApprovalsForMaintenance"],
        evidence:
          "Only exec-approvals-generated-migration.ts uses the synchronous update adapter in production; runtime edits, removal and restoration dispatch to the writer.",
      },
    ],
  ],
  [
    "src/infra/package-update-activation-journal.ts",
    [
      {
        tier: "T3",
        operations: [
          "openPackageActivationJournal.withDatabase.validate",
          "openPackageActivationJournal.readRow",
          "openPackageActivationJournal.transition",
          "openPackageActivationJournal.replaceCompleted",
          "openJournal.withDatabase.validate",
          "openJournal.readRow",
          "openJournal.transition",
          "openJournal.replaceCompleted",
          "createPackageActivationJournal",
          "createPackageActivationJournal.verifyPrivate",
        ],
        evidence:
          "CLI admission/status: src/cli/update-cli/update-command-run.ts:208, status.ts:240. Guarded swap: update-command-package.ts:542,645 → src/infra/package-update-swap.ts:342,356 → package-update-activation-prepare.ts:189,298; standalone recovery package-update-activation-sealed.ts opens strict or settlement-only inspection through openJournal; both are cold CLI-only paths with unchanged SQL operations.",
      },
    ],
  ],
  [
    "src/infra/package-update-activation-status.ts",
    [
      {
        tier: "T3",
        operations: [
          "readReleasedPackageActivationReceipt.validate",
          "readReleasedPackageActivationReceipt",
        ],
        evidence:
          "CLI status src/cli/update-cli/status.ts:240 → src/infra/package-update-activation.ts:144; CLI preflight update-command-run.ts:208 → activation.ts:79,40.",
      },
    ],
  ],
  [
    "src/infra/restart-handoff.ts",
    [
      {
        tier: "T2",
        operations: ["selectGatewayRestartHandoffRowSync"],
        evidence:
          "Native reads only serve server-startup-bootstrap.ts boot admission, daemon CLI status.gather.ts, and Doctor gateway-daemon-flow.ts; ordinary Gateway runtime does not call this reader.",
      },
      {
        tier: "T3",
        operations: [
          "consumeGatewayRestartHandoffSync",
          "consumeGatewayRestartHandoffSync.removeCurrent",
        ],
        evidence:
          "Only CLI gateway-cli/register-restart-handoff.ts:61 calls consumeGatewayRestartHandoffSync and its private removeCurrent helper.",
      },
    ],
  ],
  [
    "src/infra/restart-intent.ts",
    [
      {
        tier: "T3",
        operations: ["writeGatewayRestartIntentForTargetSync", "clearGatewayRestartIntentSync"],
        evidence:
          "Native service CLI intent recording and exact-owned cleanup: daemon-cli/lifecycle-restart-intent.ts, lifecycle-unmanaged.ts, daemon/launchd-stop.ts; runtime signal consumption uses restart-lifecycle.worker.ts. Gateway system-agent uses host.request, not daemon lifecycle.",
      },
    ],
  ],
  [
    "src/infra/restart-sentinel-store.ts",
    [
      {
        tier: "T3",
        operations: [
          "writeRestartSentinelRowIfRevisionSync",
          "readRestartSentinelRowForKeySync",
          "readRestartSentinelRevisionFloorSync",
          "upsertRestartSentinelRowSync",
        ],
        evidence:
          "src/infra/restart-sentinel.worker.ts:74,150 plus generated one-shot child in src/infra/update-managed-service-handoff.ts:101,439,1639,1649.",
      },
      {
        tier: "W",
        operations: ["deleteRestartSentinelRowSync", "readRestartSentinelSnapshotSync"],
        evidence:
          "Deletion and snapshot reads run in restart-sentinel.worker.ts or restart-sentinel.read.worker.ts; managed-handoff snapshot callers are also worker operations.",
      },
    ],
  ],
  [
    "src/infra/update-failure-report-receipt-store.ts",
    [
      {
        tier: "W",
        operations: [
          "replaceReceiptAtRevision",
          "reserveUpdateFailureReportReceiptRowSync",
          "completeUpdateFailureReportReceiptCleanupRowSync",
        ],
        evidence:
          "Receipt mutations and authoritative revision rereads are called only by restart-sentinel.worker.ts; report submission and artifact sweep await that physical shared-state owner.",
      },
    ],
  ],
  [
    "src/infra/session-sqlite-transcript-verification.ts",
    [
      {
        tier: "T2",
        operations: ["verifyTranscriptEvents", "verifyCanonicalSessionTranscriptSources"],
        evidence:
          "Doctor readers/import verification: src/commands/doctor-session-sqlite-missing-index.ts:80, doctor-session-sqlite-active.ts:60, doctor-session-sqlite-import.ts:302, doctor-session-sqlite-verification.ts:303; retained recovery doctor-session-sqlite-retained.ts:197.",
      },
    ],
  ],
  [
    "src/infra/sqlite-audit-record-store.ts",
    [
      {
        tier: "T2",
        operations: [
          "createSqliteAuditRecordStore.upsert",
          "createSqliteAuditRecordStore.registerLegacyMany",
        ],
        evidence:
          "Legacy migration only: src/infra/state-migrations.audit-recovery.ts:561 and state-migrations.audit-logs.ts:435,470,561; Doctor steps state-migrations.doctor.ts:1436,1457.",
      },
    ],
  ],
  [
    "src/infra/sqlite-audit-record.kernel.ts",
    [
      {
        tier: "W",
        operations: [
          "createSqliteAuditRecordKernel.deleteRecord",
          "createSqliteAuditRecordKernel.compareAndSet",
        ],
        evidence:
          "src/config/config-journal-snapshot.worker.ts → config-journal-snapshot.kernel.ts; greeting comparisons use diagnostic.compareAndSet in src/infra/sqlite-audit-record.worker.ts. No native comparison adapter remains.",
      },
      {
        tier: "T2",
        operations: [
          "createSqliteAuditRecordKernel.entries",
          "createSqliteAuditRecordKernel.upsertPreparedRecord",
          "createSqliteAuditRecordKernel.latest",
          "readAuditWriteState",
          "pruneAuditRecords",
        ],
        evidence:
          "Native entries/upsert/count/next/prune serve state-migrations.audit-checkpoints.ts, audit-recovery.ts, audit-logs.ts and CLI audit-backup.ts. Native latest serves readRecentConfigAuditRecords in Doctor and update-immutable-protection.ts. Runtime config observations use diagnostic.register in sqlite-audit-record.worker.ts; no native register adapter remains.",
      },
    ],
  ],
  [
    "src/infra/update-candidate-state.shared.ts",
    [
      {
        tier: "T3",
        operations: ["collectRegisteredPaths"],
        evidence:
          "CLI backup src/cli/update-cli/update-command-database-backup.ts:104 → src/infra/update-database-backup.ts:387; baseline update-command-initialization-run.ts:224 → update-recovery-baseline-capture.ts:343; worker inventory modes update-candidate-state.worker.ts:49,68,73.",
      },
    ],
  ],
  [
    "src/infra/update-candidate-state.ts",
    [
      {
        tier: "W",
        operations: ["snapshotUpdateCandidateState.transform"],
        evidence:
          "Snapshot sole executor src/infra/update-candidate-state.worker.ts:63 (isolated candidate child).",
      },
    ],
  ],
  [
    "src/infra/update-run-admission.ts",
    [
      {
        tier: "T3",
        operations: ["runUpdateRunAdmission"],
        evidence:
          "createUpdateRun is the only caller: Gateway/update campaigns dispatch updateRuns.create to update-run-mutation.worker.ts; native create calls are CLI update-command-run.ts and update-repair-command.ts. The existing-schema and bootstrap transactions retain the worker's transaction/commit admission callback.",
      },
    ],
  ],
  [
    "src/infra/update-run-ledger.ts",
    [
      {
        tier: "T3",
        operations: ["createUpdateRun"],
        evidence:
          "Gateway server-methods/update.ts and update-startup-auto-run.ts use createUpdateRunAsync; update-run-mutation.worker.ts executes creation. Remaining native callers are update-command-run.ts and update-repair-command.ts. Legacy supersession remains an explicit CLI-only option.",
      },
      {
        tier: "T3",
        operations: ["reconcilePackageOwnerRefusal", "finishInterruptedUpdateBeforeActivation"],
        evidence:
          "Only update-repair-command.ts calls reconcilePackageOwnerRefusal; update-command-mutable-signals.ts calls finishInterruptedUpdateBeforeActivation under its CLI executor. Their package/activation custody checks remain intact.",
      },
    ],
  ],
  [
    "src/infra/update-run-read.kernel.ts",
    [
      {
        tier: "T3",
        operations: ["readUpdateRunRecord", "hasStoredUpdateRecovery", "readUpdateRuns"],
        evidence:
          "Runtime reads dispatch through update-run-reader.ts to openclaw-state-read.worker.ts; mutations read their current record in update-run-mutation.worker.ts, reconciliation and interruption workers. Native readers serve CLI update-command-* / update-repair-command.ts, Doctor admission, update-migrated-finalize.worker.ts and update-repair-turn-worker.ts. Gateway update/report/restart/notice and startup campaign callers use async APIs; generated managed-handoff ledger reads execute in the helper child.",
      },
    ],
  ],
  [
    "src/infra/update-run-recovery-store.ts",
    [
      {
        tier: "T3",
        operations: ["readRecoveryRows"],
        evidence:
          "Runtime mutation/reconciliation/interruption readers execute in existing workers. Native load/inspect recovery callers are update CLI repair, result, rollback and terminal owners plus CLI managed-handoff cleanup; no Gateway reader uses the synchronous recovery facade. Recovery exclusion is retained as activation/rollback custody, not removed as bookkeeping.",
      },
    ],
  ],
  [
    "src/infra/update-run-write.ts",
    [
      {
        tier: "T3",
        operations: ["persistRun"],
        evidence:
          "Gateway update/run, boot observations, notices and startup campaigns use update-run-write.async.ts and the existing update-run-mutation.worker.ts writer. Remaining native mutateRun callers are CLI update-command-* and Doctor; update-migrated-finalize.worker.ts, reconciliation/interruption workers and the generated managed-handoff helper also own native transactions. No synchronous runtime fallback is retained.",
      },
    ],
  ],
  [
    "src/node-host/node-worker-lineage-completion.ts",
    [
      {
        tier: "W",
        operations: ["recordCompletion"],
        evidence:
          "Detached anchor spawned at src/process/supervisor/service-child-relay.ts:167; only service-child-group-anchor.ts:229,273 calls completion. W denotes the isolated supervisor subprocess.",
      },
    ],
  ],
  [
    "src/pairing/pairing-store-sqlite.ts",
    [
      {
        tier: "T2",
        operations: [
          "updateChannelPairingStateSnapshot",
          "readChannelPairingRequests",
          "readChannelPairingSnapshotFromDatabase",
          "writeChannelPairingStateToDatabase",
        ],
        evidence:
          "Runtime mutations execute in pairing-store.worker.ts through the shared-state writer registry. Native snapshots remain only in state-migrations.channel-pairing.ts for Doctor. The released synchronous SDK reader calls readChannelAllowEntries only; its shared allowlist query remains T1.",
      },
    ],
  ],
  [
    "src/hooks/install-record-transaction.ts",
    [
      {
        tier: "T3",
        operations: ["stageHookInstall", "stageHookInstall.rollback"],
        evidence:
          "CLI install/update only: cli/plugins-install-command.ts calls stageHookInstall; hooks/update.ts reaches it only through cli/plugins-update-command.ts. Rollback belongs to that same offline install transaction.",
      },
    ],
  ],
  [
    "src/state/agent-deletion-journal.read.ts",
    [
      {
        tier: "W",
        operations: ["readAgentDeletionJournalStatusInDatabase"],
        evidence:
          "src/state/openclaw-state-read-handlers.ts under read worker; other executor src/state/openclaw-agent-execution.worker.ts:190.",
      },
    ],
  ],
  [
    "src/state/agent-deletion-journal-recovery.ts",
    [
      {
        tier: "W",
        operations: ["resolveAgentDeletionRecoveryHolds"],
        evidence:
          "Only agent-deletion-recovery.worker.ts and worker-only journal completion resolve holds; reconstruction and Doctor hold producers remain separate native maintenance operations",
      },
    ],
  ],
  [
    "src/state/agent-provenance.ts",
    [
      {
        tier: "W",
        operations: ["deleteAgentProvenanceForAgent"],
        evidence:
          "Only completeAgentDeletionJournalInDatabase, reached from agent-deletion.worker.ts, deletes provenance; lifecycle incarnation readers retain synchronous live-authority checks",
      },
    ],
  ],
  [
    "src/state/agent-provenance.kernel.ts",
    [
      {
        tier: "W",
        operations: [
          "listAgentProvenanceInDatabase",
          "recordAgentProvenanceInDatabase",
          "readAgentProvenanceBatchInDatabase",
        ],
        evidence:
          "agentProvenance.list/readBatch execute through agentProvenanceReadOperations in the read-only registry; record executes through agentProvenanceOperations in agent-provenance.worker.ts; native synchronous lifecycle guards use the joined projection in agent-lifecycle-read.kernel.ts",
      },
    ],
  ],
  [
    "src/state/config-machine-state-write.ts",
    [
      {
        tier: "T3",
        operations: ["updateConfigMachineState", "updateConfigMachineStateInDatabase"],
        evidence:
          "Native updates serve CLI hook install/update via hooks/install-record-transaction.ts, onboarding via commands/onboard-guided.ts, Doctor auth and retired/config-state migrations. Other updates execute in existing state, node-config, model-catalog, TUI, push-web, telemetry and promotions workers. Shared writeConfigMachineState/upsertConfigMachineState retain their native auth-profile callers.",
      },
      {
        tier: "W",
        operations: ["deleteConfigMachineState"],
        evidence:
          "src/state/onboarding-recommendations.ts:77 submits clear → worker registry :171 → onboarding-recommendations.kernel.ts:178.",
      },
      {
        tier: "T2",
        operations: ["importConfigMachineState"],
        evidence:
          "Only migrations src/infra/state-migrations.config-machine-state.ts:71 and state-migrations.update-check.ts:66; Doctor roots doctor-config-preflight.cron.ts:27 and state-migrations.doctor.ts:910,1394.",
      },
    ],
  ],
  [
    "src/state/github-publication-session-lifecycles.ts",
    [
      {
        tier: "W",
        operations: [
          "insertGitHubPublicationSessionLifecycle",
          "readGitHubPublicationSessionLifecycle",
        ],
        evidence:
          "Native insert/read kernels run only in gateway/github-publication-store.worker.ts, gateway/github-personal-publication-store.worker.ts, state/github-publication.worker.ts and state/openclaw-state-read.worker.ts. Gateway callers use readGitHubPublicationSessionLifecycleInWorker; remaining native references are test fixtures.",
      },
    ],
  ],
  [
    "src/state/openclaw-agent-canonical-validation-receipt.ts",
    [
      {
        tier: "T2",
        operations: ["loadOpenClawAgentCanonicalValidationReceipt"],
        evidence:
          "setOpenClawAgentDatabaseValidation loads the receipt only during registry/schema admission; the other caller is openclaw-agent-db-readonly-open.ts under !isMainThread. Runtime hasPersistedOpenClawAgentCanonicalValidation consumes only the admitted cache.",
      },
      {
        tier: "T2",
        operations: ["clearPersistedOpenClawAgentCanonicalValidation"],
        evidence:
          "Invalidation is restricted to startup/Doctor main-key migration and allowStoredAlias import/repair branches; ordinary session writers do not enable those branches.",
      },
      {
        tier: "W",
        operations: ["recordOpenClawAgentCanonicalValidation"],
        evidence:
          "src/config/sessions/session-accessor.sqlite-mutation-worker.runtime.ts:392; loaded only by archive.worker.ts:523,594.",
      },
    ],
  ],
  [
    "src/state/openclaw-agent-db-path-repair.ts",
    [
      {
        tier: "T3",
        operations: ["repairOpenClawAgentDatabasePaths"],
        evidence:
          "Only noteDoctorAgentDatabasePathHealth calls the repair, within its Doctor transaction. Entry: doctor:state-integrity run callback in src/flows/doctor-health-contributions-initial.ts.",
      },
    ],
  ],
  [
    "src/state/openclaw-agent-db-registry.ts",
    [
      {
        tier: "T2",
        operations: ["registerOpenClawAgentDatabase"],
        evidence:
          "Database-open admission only: openclaw-agent-db.ts registers a newly admitted physical store; openclaw-agent-db-schema.ts registers after schema initialization. Runtime async opens perform admission in the agent executor; synchronous SDK/Doctor opens retain the admission exception.",
      },
      {
        tier: "T2",
        operations: ["resolveRegisteredAgentDatabaseStoredPath"],
        evidence:
          "Private locator query used only by database-open registration admission and unregisterOpenClawAgentDatabase; unregister runs in openclaw-agent-db-registry.worker.ts or offline state-migrations.media-persistence.ts.",
      },
      {
        tier: "W",
        operations: ["unregisterOpenClawAgentDatabase"],
        evidence:
          "Runtime removal is dispatched by openclaw-agent-db-registry.worker.ts; the only native production caller is offline Doctor migration state-migrations.media-persistence.ts. No Gateway native caller remains.",
      },
      {
        tier: "T3",
        operations: ["unregisterOpenClawAgentDatabases"],
        evidence:
          "Plural unregister: CLI claw removal src/templates/lifecycle-delete-support.ts:519 → cli/templates-cli.runtime.ts:562; CLI agent deletion src/commands/agents.commands.delete.ts:450 → cli/program/register.agent.ts:183.",
      },
    ],
  ],
  [
    "src/state/openclaw-state-ownership-operations.ts",
    [
      {
        tier: "T3",
        operations: ["claimOwnershipRow", "claimOpenClawStateOwnership"],
        evidence:
          "Only src/cli/program/register.database.ts:56 invokes claim; its private claimOwnershipRow calls remain within this CLI operation.",
      },
    ],
  ],
  [
    "src/state/openclaw-state-snapshot-sanitizer.ts",
    [
      {
        tier: "T3",
        operations: ["sanitizeOpenClawGlobalStateSnapshot"],
        evidence:
          "CLI SQLite/git backups: src/snapshot/local-repository.ts:148, git-backup.ts:310 → openclaw-snapshot-copy.ts:68; archive/Doctor backup via src/infra/backup-create.ts:320,332,352 → backup-sqlite-snapshot.ts:287; developer reliability scripts also use the provider.",
      },
    ],
  ],
  [
    "src/state/user-model-accounts.ts",
    [
      {
        tier: "W",
        operations: ["updateUserModelAuthProfile"],
        evidence:
          "Only agents/auth-profiles/store.worker.ts calls this writer, in authProfiles.personalReplace and authProfiles.personalUsage. These registered worker handlers update credentials and usage respectively; no Gateway main-thread receiver remains.",
      },
      {
        tier: "W",
        operations: ["connectUserModelAccount"],
        evidence:
          "Personal sign-in persistence executes only through userProfiles.modelAccount.connect in user-profiles.worker.ts. Inventory/link/unlink kernels retain T1 for deprecated v2026.9.8 Gateway SDK methods; bundled callers use the Async replacements. Shared credential/OAuth kernels and the live account pin guard also retain T1.",
      },
      {
        tier: "T3",
        operations: ["renameUserProfileAuthLinks"],
        evidence:
          "Only src/commands/doctor-auth-flat-profiles.ts:1727 (Doctor alias migration), invoked by doctor/repair-sequencing.ts:189 and doctor/auth-profile-repair.ts:45.",
      },
      {
        tier: "W",
        operations: ["mergeUserModelAccounts"],
        evidence:
          "Only src/state/user-profiles-merge.ts:57, executed by user-profile-writes.worker.ts:375,425,482.",
      },
    ],
  ],
  [
    "src/state/user-profile-events.ts",
    [
      {
        tier: "T3",
        operations: ["publishUserProfileAuthorityChange"],
        evidence:
          "Native calls only user-profiles-owner-migration.ts:68 and user-profiles-tailscale-migration.ts:98 from src/commands/doctor/repair-sequencing.ts:353,354; remaining calls run in profile/preferences/channel-identity workers.",
      },
    ],
  ],
  [
    "src/state/user-profile-github-identity.ts",
    [
      {
        tier: "W",
        operations: [
          "resolveUserProfileGitHubAttributionInDatabase",
          "selectUserProfileRoleAuthority",
          "prepareUserProfileGitHubMerge",
          "readGitHubIdentityBinding",
          "selectGitHubProfileAlias",
          "applyVerifiedGitHubIdentity",
          "applyVerifiedGitHubIdentity.writeIdentity",
        ],
        evidence:
          "Read dispatcher src/state/openclaw-state-read.worker.ts:577; mutations user-profile-writes.worker.ts:474,482 and merges :375,425. Role authority runs only through user-profiles.worker.ts:152. ensureEmail path user-profiles.worker.ts:61; private writeIdentity only from applyVerifiedGitHubIdentity; private selectGitHubProfileAlias only from readGitHubIdentityBinding and the read-worker cached-binding command (openclaw-state-read.worker.ts:520).",
      },
    ],
  ],
  [
    "src/state/user-profiles-internal.ts",
    [
      {
        tier: "T3",
        operations: ["selectProfileDisplayEntries"],
        evidence:
          "Profile authority/snapshot reads and catalog publication run in profile/channel/enterprise workers. The native publication caller is user-profiles-owner-migration.ts repairMergedGatewayOwnerProfile via Doctor repair-sequencing.ts; preview-warnings.ts inspects without publishing. Shared selectResolvedUserProfile retains native SDK callers.",
      },
      {
        tier: "W",
        operations: [
          "insertUserProfile",
          "selectUserProfileEmailAlias",
          "setUserProfileEmailBinding",
          "readProfileAvatarInDatabase",
        ],
        evidence:
          "Creation/link/merge/sync calls flow through src/state/user-profiles.worker.ts:61,69,71 and user-profile-writes.worker.ts:375,400,409,425,480; identity/avatar reads dispatch only from openclaw-state-read.worker.ts:577,604,631.",
      },
    ],
  ],
  [
    "src/state/user-profiles-merge.ts",
    [
      {
        tier: "W",
        operations: ["mergeUserProfiles"],
        evidence:
          "Only src/state/user-profile-writes.worker.ts:375,425,482 executes mergeUserProfiles.",
      },
    ],
  ],
  [
    "src/state/user-profiles-owner.ts",
    [
      {
        tier: "T3",
        operations: ["readGatewayOwnerProfileRows"],
        evidence:
          "Native reader only user-profiles-owner-migration.ts:25,52 → src/commands/doctor/shared/preview-warnings.ts:683 and doctor/repair-sequencing.ts:354; other caller is user-profiles.worker.ts:78.",
      },
      {
        tier: "W",
        operations: ["ensureGatewayOwnerProfileRow"],
        evidence:
          "src/state/user-profiles.ts:320 invokes ensureGatewayOwnerProfileRow; sole executor user-profiles.worker.ts:78.",
      },
    ],
  ],
  [
    "src/state/user-profiles.ts",
    [
      {
        tier: "W",
        operations: [
          "ensureProfileForProviderIdentity.selectExistingIdentity",
          "ensureProfileForProviderIdentity",
          "adoptDisplayNameIfEmpty",
        ],
        evidence:
          "Sole executor src/state/user-profiles.worker.ts:69 → ensureProfileForTailscaleIdentity → user-profiles.ts:339,345.",
      },
    ],
  ],
  [
    "src/trajectory/runtime-store.sqlite.ts",
    [
      {
        tier: "W",
        operations: ["appendSqliteTrajectoryRuntimeEventsWithWriter"],
        evidence:
          "Durable sinks dispatch trajectory.events.append through openclaw-agent-execution-operations.ts. Incognito sinks append through the session actor memory backend without SQLite. Synchronous fixture append and retention exist only in runtime-store.test-support.ts.",
      },
      {
        tier: "T3",
        operations: ["loadSqliteTrajectoryRuntimeEventRowsSync"],
        evidence:
          "Native row reads are CLI-only: commands/sessions-tail.ts tail/follow. The other caller is session-history-read-operation.worker.ts. Trajectory export and the runtime-testing SDK use the async loader, not this native row reader.",
      },
    ],
  ],
  [
    "src/transcripts/store-read.ts",
    [
      {
        tier: "W",
        operations: [
          "readLatestTranscriptEntry",
          "readTranscriptEntry",
          "readTranscriptPage",
          "readStoredTranscriptNotes",
        ],
        evidence:
          "Ordinary reads dispatch through store-worker-read.ts; streamed library exports dispatch through store-export.worker.ts. TranscriptsStore no longer invokes a native generator; remaining host references are types and pure helpers.",
      },
    ],
  ],
]);
const workerModules = new Set([
  "src/config/sessions/session-accessor.sqlite-compaction.ts", // Only session-manager-metadata.worker.ts calls the required-worker entry point; the async facade imports its type only.
  "src/agents/sandbox/persistent-exec-store.kernel.ts", // Mutations and registry removal checks run in persistent-exec-store.worker.ts and registry-write.worker.ts; reads dispatch through openclaw-state-read-operation-registry.ts in the read worker.
  "src/state/openclaw-agent-execution-maintenance.ts", // Only openclaw-agent-execution.worker.ts constructs this owner; admission invokes its startup repair callback solely inside that worker.
  "src/config/sessions/session-accessor.sqlite-entry-identity.ts", // Only reaction (agent execution worker), suggestion (sharing/transcript workers), and sharing native (sharing worker; host imports are types) kernels call this reader.
  "extensions/memory-core/src/memory/manager-publication-postgres.ts", // Only manager-publication.worker.ts binds this adapter to the admitted agent execution worker connection.
  "src/infra/database-engine/postgres-vector.ts", // Accepts only an admitted PostgresSqlConnection; the shared executor dispatches through PostgresSyncConnection to postgres-sync/bridge.worker.ts, never native SQLite.
  "src/infra/database-engine/port-descriptor.ts", // SQL entry points run only in port-command.entry.worker.ts, port.worker.ts, and database-backup.operations.ts in its dedicated worker.
  "src/plugin-state/plugin-state.worker.ts", // Only openclaw-state.worker.ts imports and calls this command dispatcher; its nested callbacks share that worker ownership.
  "src/config/sessions/session-suggestion-store.kernel.ts", // session-sharing-store.worker.ts owns add/claim/release/finalize; session-transcript.worker.ts owns list. The host read facade imports only its type.
  "src/config/sessions/session-cold-storage-inventory.ts", // Only session-cold-storage-worker.ts calls readSessionColdStorageInventory, dispatched by session-transcript.worker.ts.
  "src/boards/sqlite-board-store.kernel.ts", // Only sqlite-board-store.worker.ts executes boards.applyOps/putWidget/grant; session-history-read-operation.worker.ts owns board-snapshot/board-widget-document reads. Host imports are type-only.
  "src/infra/session-cost-usage-cache.kernel.ts", // Only session-cost-usage-worker.ts reads rollups; openclaw-agent-execution-operations.ts dispatches usageCache.writeRollup/prune in the agent execution worker. The host cache writer imports only types.
  "src/trajectory/runtime-retention.sqlite.ts", // SQL runs only through agent execution, session-history read, and entry-patch workers; runtime-retention.ts uses only the pure due/state helpers.
  "src/config/sessions/session-reaction-store.read.ts", // Only the history worker reader calls reaction SQL; synchronous test inspection lives in test support.
  "src/config/sessions/session-sharing-store.native.ts", // Membership mutations run only in session-sharing-store.worker.ts; host imports are type-only.
  "src/config/sessions/session-accessor.sqlite-participants.native.ts", // Participant mutation SQL runs only through the sharing worker; host imports are type-only.
  "src/config/sessions/session-group-categories.read.ts", // Category enumeration runs only in session-sharing-store.worker.ts.
  "src/config/sessions/session-pending-input-history.kernel.ts", // History-read worker owns all remaining callers.
  "src/infra/session-cost-usage-cache-read.ts", // Usage-cache reads run only in session-transcript.worker.ts.
  "src/templates/provenance-runtime-read.kernel.ts", // Only templateInstallSchemaOperations in provenance-runtime-read.worker.ts reads consent rows; host imports are types.
  "src/templates/provenance-runtime-read.worker.ts", // Shared-state registry owns templates.install-schema-versions.
  "src/state/user-profiles.worker.ts", // Registered profile operations; Gateway submits commands through user-profile-operations.ts.
  "src/state/user-profile-writes.worker.ts", // Shared-state profile mutation implementation; loaded by the profile worker only.
  "src/state/user-profile-read.worker.ts", // Shared-state read registry owns catalog identity and channel identity reads.
  "src/state/user-profile-enterprise-github-identity.ts", // Profile read-worker dispatch and profile writer merge/commit projections own these SQL readers; host attribution uses the async read command.
  "src/state/user-profile-catalog-identity.read.ts", // Only readUserProfileReadCommand in user-profile-read.worker.ts executes this reader.
  "src/gateway/github-personal-publication-store.worker.ts", // Shared-state publication request, mutation, and read workers only.
  "src/gateway/github-publication-store.worker.ts", // Shared-state publication request, mutation, and read workers only.
  "src/state/user-github-connections.worker.ts", // openclaw-state-worker-registry installs its operation table; host imports are type-only.
  "src/config/sessions/session-accessor.sqlite-worktree-owner.ts", // Only session-entry-read.worker.ts reads the worktree projection after owner-protection's worker cutover.
  "src/config/sessions/session-accessor.sqlite-transcript-incremental-read.ts", // Anchor-read kernel worker roots; the sqlite-read wrapper's sole value caller is correction.ts runNative under !isMainThread.
  "src/gateway/worker-environments/placement-move-intent.ts", // Move reads and mutations run only in placement lifecycle, turn-claim, and projection workers.
  "src/state/user-background.store.ts", // Background read/write workers; preference validation and profile merge/link/GitHub-sync also run in shared-state workers.
  "src/gateway/worker-environments/local-workspace-store.kernel.ts", // Projection read/write workers and worktree retirement worker only.
  "src/gateway/worker-environments/local-workspace-manifest-scan.ts", // State-read workers capture rows; Git workspace workers compute manifests from detached snapshots. Host imports are types.
  "src/gateway/worker-environments/local-workspace-cas.kernel.ts", // Shared-state read/manifest workers traverse immutable content; local-workspace-store.worker.ts alone prepares, prunes, and sweeps it.
  "src/skills/library/import.kernel.ts", // Upload commands execute only in the shared-state writer.
  "src/skills/library/read.kernel.ts", // Only openclaw-state-read-operation-registry.ts imports this worker operation table.
  "src/skills/library/service.kernel.ts", // Library catalog and revision reads use the shared-state read registry.
  "src/skills/workshop/changes.kernel.ts", // changes.worker.ts owns append/list SQL through the shared-state registry.
  "src/skills/workshop/skill-usage.kernel.ts", // changes.worker.ts owns recordSkillUsageInDatabase; host imports are type-only.
  "src/config/sessions/conversation-delivery-store.kernel.ts", // Agent execution registry writes and session transcript worker reads only.
  "extensions/memory-core/src/memory-entry-origin-reads.ts", // Memory search worker origin-read commands only.
  "extensions/memory-core/src/memory-entry-origins-delete.ts", // Memory origin worker delete command only.
  "extensions/memory-core/src/memory-forget-index-read.ts", // Memory search worker forget-index-plan command only.
  "extensions/memory-core/src/memory-forget-kernel.ts", // Memory origin worker forget mark and purge commands only.
  "extensions/memory-core/src/standing-intents-kernel.ts", // Standing-intent worker command dispatcher only.

  "extensions/memory-core/src/memory/manager-index-metadata.ts", // Only the SQLite/PostgreSQL publication worker adapters write metadata and promote legacy cache identities.
  "extensions/memory-core/src/memory/manager-embedding-cache.ts", // Cache SQL, including iterator reads, is called only by manager-publication.worker.ts.
  "extensions/memory-core/src/memory/manager-rebuild-embeddings.ts", // Only manager-index-read.ts calls this lookup, from manager-search.worker.ts, manager-publication.worker.ts, or its worker-bound manager-publication-postgres.ts adapter.
  "extensions/memory-core/src/memory/manager-chunk-writer.ts", // Only manager-source-index-kernel.ts calls this writer, from manager-publication.worker.ts.
  "extensions/memory-core/src/memory/manager-source-index-kernel.ts", // Hash reads and source mutations are called only by manager-publication.worker.ts.
  "extensions/memory-core/src/memory/manager-retrieval-read.ts", // Search and publication workers own all SQL; host imports are types or the metadata key.
  "extensions/memory-core/src/memory/manager-search.ts", // Only manager-search.worker.ts executes keyword SQL; host imports are the pure prepareExactPathMatcher helper or types.
  "extensions/memory-core/src/memory/manager-search-postgres.ts", // Only manager-search.worker.ts calls this PostgreSQL query adapter with its admitted worker connection; conformance calls the same internal entry.
  "extensions/memory-core/src/memory/manager-vector-rebuild-state.ts", // Retrieval, source-index and database-publication kernels run in the search/publication workers; the host consumes published vector facts.

  "extensions/knowledge/src/identity-store.ts", // Only StorageBase (storage-worker.ts via storage-host.ts) and StoreRegistry (registry-worker.ts via registry-host.ts) open this store.
  "extensions/knowledge/src/recent-activity.ts", // recentActivity runs only in KnowledgeStorage inside storage-worker.ts.
  "extensions/knowledge/src/registry-schema.ts", // Only StoreRegistry, constructed by registry-host.ts in registry-worker.ts, admits this schema.
  "extensions/knowledge/src/retrieval.ts", // Index SQL runs only in KnowledgeStorage inside storage-worker.ts; other imports use the pure eligible/exactLookup helpers.
  "extensions/knowledge/src/storage-base.ts", // Base of KnowledgeStorage, constructed only by storage-host.ts in storage-worker.ts.
  "extensions/knowledge/src/storage-journal.ts", // Layer of KnowledgeStorage, constructed only by storage-host.ts in storage-worker.ts.
  "extensions/knowledge/src/storage-schema.ts", // Called only by identity-store.ts and store-registry.ts schema admission inside the storage and registry workers.
  "extensions/knowledge/src/store-registry.ts", // StoreRegistry is constructed only by registry-host.ts in registry-worker.ts; main-thread imports are types and bindingState.
  "extensions/team-reports/src/store-database.ts", // Only store.worker.ts and offline port workers admit this schema.
  "extensions/workboard/src/sqlite-store-kernel.ts", // Workboard SQLite worker backend factory only.
  "extensions/workboard/src/sqlite-store-sessions-board.ts", // Workboard worker kernel sessions-board store only.
  "extensions/workboard/src/sqlite-store-write.ts", // Workboard worker kernel card writes only.

  "packages/memory-host-sdk/src/memory-entry-origins.ts", // Private memory SDK origin queries serve search and origin workers only.

  "src/agents/mcp-oauth-store.kernel.ts", // MCP OAuth write dispatcher and shared-state read worker only.
  "src/agents/harness/native-hook-relay-store.kernel.ts", // native-hook-relay-store.worker.ts owns all runtime SQL.

  "src/audit/audit-event-read.kernel.ts", // Audit event list SQL runs only in the shared-state worker dispatcher.
  "src/audit/audit-event-store.ts", // Audit writer worker owns inserts/pruning; host listing delegates to the worker.
  "src/audit/audit-identity.ts", // Audit writer worker alone reaches identity key reads and writes.
  "src/audit/execution-decision-facts.ts", // Audit writer and audit read workers alone execute decision-fact SQL.
  "src/audit/execution-identity-context.ts", // Audit writer persists contexts; audit read worker owns inspection SQL.
  "src/audit/execution-owner-lifecycle-binding-store.ts", // Cron worker receipt binding and terminal pruning own lifecycle metadata SQL.
  "src/audit/execution-owner-lifecycle-receipts.ts", // Audit read worker alone projects Cron lifecycle receipts.
  "src/audit/message-delivery-audit-store.ts", // Audit read worker alone pages and counts delivery audit events.
  "src/audit/message-delivery-progress-store.ts", // Audit writer owns progress writes; audit read worker owns progress queries.
  "src/audit/message-execution-binding.ts", // Audit writer alone ensures and confirms outbound execution bindings.

  "src/channels/message/ingress-queue-health.kernel.ts",
  "src/channels/message/ingress-queue.kernel.ts",

  "src/config/sessions/session-accessor.sqlite-archive.worker.ts", // The archive owner starts this native worker; cold-prepare callbacks stay inside its read-only scope and private-port dispatcher.
  "src/config/sessions/session-accessor.sqlite-archive-selection.ts", // Archive worker read-page selection only.
  "src/config/sessions/session-accessor.sqlite-mutation-worker.runtime.ts",
  "src/config/sessions/session-accessor.sqlite-summary.ts", // Only session-transcript.worker.ts dispatches the summary kernel at runtime.
  "src/config/sessions/session-accessor.sqlite-transcript-binding.ts", // History worker transcript-binding reader only.
  "src/config/sessions/session-cold-storage-selection.ts", // Archive-worker preparation and cold-mutation kernels only.
  "src/config/sessions/session-cold-storage-worker.ts", // Archive-worker cold-mutate dispatcher only.
  "src/config/sessions/session-cold-storage-read.worker.ts", // Transcript/history workers dispatch cold probes; verified-chunk reads stay in their read snapshots.
  "src/config/sessions/session-transcript-hydration.worker.ts", // Only session-transcript-hydration-read.worker.ts dispatches hydration; cold records stream inside that worker.
  "src/config/sessions/session-membership-facts.ts", // Transcript worker session-membership-facts dispatcher only.

  "src/cron/store/run-history.kernel.ts", // Cron read worker and shared-state Cron dispatch own history SQL.
  "src/cron/store/job-name.kernel.ts", // Shared-state/history workers and Doctor transaction hooks only.
  "src/cron/store/run-receipt-delivery.ts", // Cron admission and recovery workers own delivery-attempt SQL.
  "src/cron/store/run-receipt-trigger-state.ts", // Cron mutation, admission and recovery workers own trigger retirement SQL.

  "src/gateway/github-publication-shared-read.kernel.ts", // Shared publication queries are called only by the state read worker.
  "src/gateway/managed-image-record-store.kernel.ts", // Shared-state worker dispatch only; host exports are row codecs.
  "src/gateway/operator-approval-store.receipts.ts", // Audit read worker alone reaches receipt readers through the approval-store barrel.
  "src/gateway/session-history-worker-reader.ts", // Only session-transcript.worker.ts dispatches history metadata reads.

  "src/gateway/worker-environments/inference-store.kernel.ts", // Inference worker dispatcher creates this kernel only.
  "src/gateway/worker-environments/placement-read-projection.ts", // Worker projection; the retained final move guard has an explicit T1 override.
  "src/gateway/worker-environments/session-attachment-store.ts", // Environment worker kernel and read-worker attachment facts only.
  "src/gateway/worker-environments/store-mutations.ts", // Environment worker kernel, transitions, and initialization only.
  "src/gateway/worker-environments/store-row-codec.ts", // Environment and placement workers plus shared-state read-worker facts only.
  "src/gateway/worker-environments/store-transitions.ts", // Environment worker kernel owns transition operations only.
  "src/gateway/worker-environments/store-write.ts", // Environment worker mutation receipt change counts only.
  "src/gateway/worker-environments/store.kernel.ts", // Environment worker dispatcher creates this kernel only.
  "src/gateway/worker-environments/terminal-environment-retention.ts", // Read-worker prune pages and environment worker pruning only.

  "src/infra/device-auth-store.kernel.ts", // Shared-state worker SQL; pairing token retirement is supplied only by its worker rotation kernel.
  "src/infra/device-pairing-cloud-worker.ts", // Bootstrap worker dispatcher owns binding checks and completion writes.
  "src/infra/push-apns-store-transaction.ts", // APNs worker cleanup and pairing worker clearApnsNodeIds only.
  "src/infra/push-apns-store.ts", // SQL read kernels are called only by the APNs worker dispatcher.
  "src/infra/session-cost-usage-worker.ts",
  "src/infra/update-candidate-exec-approvals.ts", // Approval projections run in the update-candidate-state worker.
  "src/infra/update-candidate-plugins.ts", // Plugin inventory and copying run in the update-candidate-state worker.
  "src/infra/update-run-interruption-store.ts", // Interruption writes use the shared-state worker; host imports are pure.
  "src/infra/update-run-dispatch.worker.ts", // Shared-state backend owns update-run dispatch and retains its writer lifecycle.
  "src/infra/update-run-reconciliation.read.ts", // Reconciliation reads use state-read and reconciliation workers.

  "src/infra/outbound/delivery-queue-media-staging.kernel.ts", // Media retention SQL executes through delivery-queue.worker.
  "src/infra/outbound/delivery-queue-storage.kernel.ts", // Outbound reads use state-read; mutations use delivery storage workers.

  "src/node-host/node-worker-launch-store.kernel.ts", // node-worker-journal.worker.ts and the spawned service-child-group anchor own launch SQL.
  "src/node-host/node-worker-turn-store.kernel.ts", // Turn kernels are instantiated only by node-worker-journal.worker.

  "src/plugin-state/plugin-blob-store.sqlite.ts", // Plugin-blob writes and shared-state read worker only.

  "src/plugins/conversation-binding-state.kernel.ts", // Shared-state worker binding-approval commands only.
  "src/plugins/official-external-plugin-catalog-snapshot-store.kernel.ts", // Shared-state worker catalog-snapshot commands only.

  "src/projects/project-registry.kernel.ts", // Project registry handler table is the only runtime caller of its SQL kernels.

  "src/secrets/store/secret-store-config-ref.kernel.ts", // Only secretStoreOperations in secret-store.worker.ts calls config-ref writes.
  "src/secrets/store/secret-store-expiry.kernel.ts", // Expiry SQL uses shared-state worker dispatch; host captures cutoffs only.
  "src/secrets/store/secret-store-metadata.kernel.ts", // Metadata, exec environment, and exact values only run through stateReadRegistry in the shared-state reader.
  "src/secrets/store/secret-store.worker.ts", // Shared-state registry owns the secretStoreOperations map.

  "src/skills/lifecycle/upload-store-commit.ts", // Skill-upload worker commit command only.
  "src/skills/lifecycle/upload-store.kernel.ts", // Skill-upload worker dispatcher only.
  "src/skills/lifecycle/upload-store.sqlite.ts", // Skill-upload worker kernels; host imports pure options only.

  "src/state/agent-provenance.worker.ts", // Shared-state registry owns agentProvenanceOperations.
  "src/state/backup-run-records.kernel.ts", // Only backupRunOperations in backup-run-records.worker.ts calls backup record writes.
  "src/state/backup-run-records.worker.ts", // Shared-state registry owns backup.recordOutcome.
  "src/state/github-personal-publication-lifecycle.ts", // Receipt SQL runs in shared-state worker dispatch; host helper enqueues commands.
  "src/state/github-publication-source.kernel.ts", // Only github-publication-source.worker.ts:63,80; its reader is instantiated by openclaw-state.worker.ts:234.
  "src/state/openclaw-state-lease-worker.ts", // Lease transaction dispatch is called only by the shared-state worker backend.
  "src/state/session-repository-workspaces.kernel.ts", // SQL callers are shared-state workspace dispatch and the state read worker.

  "src/transcripts/store-sqlite-read.ts", // SQL callers are transcript worker read/write dispatchers only.
  "src/transcripts/store-sqlite-write.ts", // SQL writes are called only by the transcript worker dispatcher.
  "src/transcripts/store-sqlite.ts", // SQL callers are transcript worker kernels; host imports are pure helpers.
  "src/transcripts/store-worker-read.ts", // Shared-state registry owns transcriptReadOperations and its snapshot reads.
  "src/transcripts/store-worker-write.ts", // Shared-state registry owns transcriptWriteOperations.
]);
const exceptionModules = new Set([
  "src/state/openclaw-state-db-transaction.ts",
  "src/state/openclaw-state-lease-store.ts",
  "src/state/openclaw-state-lease-storage.ts",
  "src/state/openclaw-agent-db-lease.ts",
  "src/infra/gateway-boot-lifecycle.ts",
  "src/infra/sqlite-staging-token.ts", // acquireSqliteStagingToken holds the private snapshot admission/retirement lock through native transactions.
]);
const cliModules = new Map([
  [
    "scripts/perf/session-cold-selection.ts",
    "Explicit developer-only benchmark of cold preparation and mutation on synthetic state; no runtime imports or Gateway callers",
  ],
  [
    "src/templates/provenance-adopted.ts",
    "Only templates migrate/remove CLI one-shots call these writers via migrate.ts and lifecycle-adopted-removal.ts; no Gateway caller",
  ],
  [
    "src/infra/package-update-activation-immutable.ts",
    "Adoption/preparation writers are called only by update-command-immutable.ts through update-immutable-install.ts; Gateway inspection dispatches immutableInstall.read through the SQLite read-only worker",
  ],
]);

function classify(file, operation, binding, guards) {
  const reviewedOperation = reviewedOperations
    .get(file)
    ?.find(
      (entry) =>
        entry.operations.includes(operation) &&
        (entry.binding === undefined || entry.binding === binding) &&
        (entry.guard === undefined || guards?.includes(entry.guard)),
    );
  if (reviewedOperation) {
    return { tier: reviewedOperation.tier, priority: 99, evidence: reviewedOperation.evidence };
  }
  const evidence = reviewed.get(file);
  if (evidence) {
    return { tier: "T1", ...evidence };
  }
  if (/\.worker\.[cm]?[jt]s$/.test(file) || workerModules.has(file)) {
    return { tier: "W", priority: 99, evidence: "Worker implementation; keep SQL in this owner" };
  }
  const cliEvidence = cliModules.get(file);
  if (cliEvidence) {
    return { tier: "T3", priority: 99, evidence: cliEvidence };
  }
  if (/^(?:scripts\/|src\/(?:cli|commands|tui)\/)/.test(file)) {
    return {
      tier: "T3",
      priority: 99,
      evidence: "CLI/Doctor/developer one-shot; reclassify if called by Gateway",
    };
  }
  if (exceptionModules.has(file)) {
    return {
      tier: "T2",
      priority: 99,
      evidence: "Boot or lock/lease primitive; exception is operation-scoped",
    };
  }
  if (
    /(?:state-migrations[./]|(?:^|[./-])(?:migration|migrations|schema|startup)(?:[./-]|$))/.test(
      file,
    )
  ) {
    return {
      tier: "T2",
      priority: 99,
      evidence: "Schema/startup/migration candidate; verify no runtime caller",
    };
  }
  return {
    tier: "T1",
    priority: 99,
    evidence: "Runtime/mixed candidate; main-thread reachability needs tracing",
  };
}

/** Only reviewed entries are proof roots; filename-based CLI/migration leads are not. */
function classifyKnownEntry(file, operation) {
  const reviewedOperation = reviewedOperations
    .get(file)
    ?.find(
      (entry) =>
        entry.operations.includes(operation) &&
        entry.binding === undefined &&
        entry.guard === undefined,
    );
  if (
    reviewedOperation?.tier === "T2" ||
    reviewedOperation?.tier === "T3" ||
    reviewedOperation?.tier === "W"
  ) {
    return reviewedOperation.tier;
  }
  if (workerModules.has(file)) {
    return "W";
  }
  if (cliModules.has(file)) {
    return "T3";
  }
  if (
    exceptionModules.has(file) ||
    (file === "src/state/openclaw-state-db-schema-runtime.ts" &&
      operation === "ensureOpenClawStateRuntimeSchema")
  ) {
    return "T2";
  }
  return undefined;
}

function ownerOf(file) {
  const parts = file.split("/");
  const depth =
    parts[0] === "src" &&
    ["agents", "config", "gateway", "infra", "skills"].includes(parts[1]) &&
    parts.length > 3
      ? 3
      : 2;
  return parts.slice(0, depth).join("/");
}

/**
 * @typedef {object} InventoryCall
 * @property {string} primitive
 * @property {number} line
 * @property {number} column
 * @property {string} operation
 * @property {string} [binding]
 * @property {string[]} [guards]
 * @property {{namespace: string, module: string, arguments: string[]}} [forwarding]
 */

function findCalls(source) {
  const names = new Map([...primitives.keys()].map((name) => [name, name]));
  const namespaces = new Map();
  for (const statement of source.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (
      bindings &&
      ts.isNamespaceImport(bindings) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      namespaces.set(bindings.name.text, statement.moduleSpecifier.text);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (primitives.has(imported)) {
          names.set(element.name.text, imported);
        }
      }
    }
  }
  /** @type {InventoryCall[]} */
  const calls = [];
  function visit(node, parentOperation, parentBinding, parentGuards, parentOwner, parent) {
    let operation = parentOperation;
    let binding = parentBinding;
    let guards = parentGuards ?? [];
    let owner = parentOwner;
    // Callback SQL needs its own proof; neither an initializer nor a caller's guard covers it.
    if (ts.isFunctionLikeDeclaration(node)) {
      owner = node;
      binding = undefined;
      guards = [];
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      binding = ts.isIdentifier(node.name) ? node.name.text : undefined;
    }
    const namedFunction =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node);
    const assignedFunction =
      (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
    if ((namedFunction || assignedFunction) && node.name && ts.isIdentifier(node.name)) {
      operation = operation ? `${operation}.${node.name.text}` : node.name.text;
    }
    if (ts.isIfStatement(node)) {
      visit(node.expression, operation, binding, guards, owner, node);
      visit(
        node.thenStatement,
        operation,
        binding,
        [...guards, node.expression.getText(source)],
        owner,
        node,
      );
      if (node.elseStatement) {
        visit(node.elseStatement, operation, binding, guards, owner, node);
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const called = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : undefined;
      const primitive = names.get(called);
      if (primitive) {
        const { line, character } = source.getLineAndCharacterOfPosition(
          expression.getStart(source),
        );
        const namespace =
          ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
            ? expression.expression.text
            : undefined;
        const forwarding =
          namespace &&
          namespaces.has(namespace) &&
          owner &&
          ts.isFunctionDeclaration(owner) &&
          (owner.name?.text === called || owner.name?.text === `${called}Legacy`) &&
          parent &&
          ts.isReturnStatement(parent) &&
          parent.expression === node &&
          owner.body?.statements.includes(parent) &&
          owner.parameters.length === node.arguments.length &&
          owner.parameters.every(
            (parameter, index) =>
              ts.isIdentifier(parameter.name) &&
              !parameter.initializer &&
              !parameter.dotDotDotToken &&
              ts.isIdentifier(node.arguments[index]) &&
              parameter.name.text === node.arguments[index].text,
          )
            ? {
                namespace,
                module: namespaces.get(namespace),
                arguments: node.arguments.map((argument) => argument.text),
              }
            : undefined;
        calls.push({
          primitive,
          line: line + 1,
          column: character + 1,
          operation,
          ...(binding === undefined ? {} : { binding }),
          ...(guards.length === 0 ? {} : { guards }),
          ...(forwarding ? { forwarding } : {}),
        });
      }
    }
    node.forEachChild((child) => visit(child, operation, binding, guards, owner, node));
  }
  visit(source, "");
  return calls;
}

export function loadInventorySources(root = defaultRoot, ref = "", staged = false) {
  const roots = ["src", "extensions", "packages", "scripts"];
  const snapshot = ref !== "" || staged;
  const result = spawnSync(
    snapshot ? "git" : "rg",
    snapshot
      ? ref
        ? ["ls-tree", "-r", "--name-only", "-z", ref, "--", ...roots]
        : ["ls-files", "-z", "--", ...roots]
      : [
          "--files",
          "--null",
          "-g",
          "*.{ts,tsx,js,mjs,mts,cts,cjs}",
          ...roots.filter((dir) => fs.existsSync(path.join(root, dir))),
        ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw result.error ?? new Error(result.stderr || "SQLite inventory source scan failed");
  }
  const sourceFiles = result.stdout
    .split("\0")
    .filter(
      (file) =>
        /\.(?:ts|tsx|js|mjs|mts|cts|cjs)$/.test(file) &&
        !excluded.test(file) &&
        !testSuites.has(file),
    );
  return snapshot
    ? loadRatchetSources(root, sourceFiles, ref)
    : new Map(sourceFiles.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")]));
}

/** @param {{ observer?: import("./lib/native-typescript.mts").NativeTypeScriptObserver }} [options] */
export function inventory(
  root = defaultRoot,
  ref = "",
  staged = false,
  texts = loadInventorySources(root, ref, staged),
  options = {},
) {
  const { observer } = options;
  using parser = createNativeTypeScriptParser({
    cwd: root,
    observer: observer && ((phase, facts) => observer(`syntax.${phase}`, facts)),
  });
  const pattern = new RegExp([...primitives.keys()].join("|"));
  const compatibility = inspectDatabaseWorkerBoundaries(
    root,
    texts,
    (file, operation) => classify(file, operation).tier !== "T1",
    classifyKnownEntry,
    // Historical snapshots supply counts; only current-source diagnostics are consumed below.
    !ref,
    observer && ((phase, facts) => observer(`semantic.${phase}`, facts)),
  );
  if (!ref && compatibility.violations.length > 0) {
    throw new Error(
      "Deprecated synchronous SQLite compatibility guard failed:\n" +
        compatibility.violations.join("\n"),
    );
  }
  const files = [...texts.keys()].filter((file) => pattern.test(texts.get(file)));
  reportNativeTypeScriptPhase(observer, "syntax.inputs", { files: files.length });
  const sources = parser.parseSourceFiles(
    files.map((fileName) => ({ fileName, text: texts.get(fileName) })),
  );
  const invalidSource = parser.getSyntacticDiagnostics()[0];
  parser.checkpoint?.("diagnostics");
  if (invalidSource) {
    throw new Error(
      `Cannot inventory invalid syntax in ${path.relative(root, invalidSource.fileName ?? root)}`,
    );
  }
  const rows = files
    .flatMap((file, index) => {
      const calls = findCalls(sources[index]);
      /** @type {Map<string, {
       * file: string,
       * owner: string,
       * tier: string,
       * priority: number,
       * calls: InventoryCall[],
       * evidence: Set<string>
       * }>} */
      const groups = new Map();
      for (const call of calls) {
        const classification = classify(file, call.operation, call.binding, call.guards);
        if (
          classification.tier === "T1" &&
          compatibility.operations.get(file)?.has(call.operation) &&
          compatibility.callLocations.get(file)?.has(`${call.line}:${call.column}`)
        ) {
          classification.tier = "T1-compat";
          classification.evidence =
            "Deprecated SDK compatibility only; no bundled value references outside reviewed compatibility boundaries. Remove in a later release after stable deprecation.";
        }
        const nonRuntimeTier = compatibility.nonRuntimeOperations.get(file)?.get(call.operation);
        if (
          classification.tier === "T1" &&
          nonRuntimeTier &&
          compatibility.nonRuntimeCallLocations.get(file)?.has(`${call.line}:${call.column}`)
        ) {
          classification.tier = nonRuntimeTier;
          classification.evidence =
            "Mechanically proven kernel: every value reference stays within reviewed worker or maintenance entries; no runtime, SDK, or unproven callback escape.";
        }
        const group = groups.get(classification.tier) ?? {
          file,
          owner: ownerOf(file),
          ...classification,
          calls: [],
          evidence: new Set(),
        };
        group.calls.push(call);
        group.evidence.add(classification.evidence);
        groups.set(classification.tier, group);
      }
      return [...groups.values()].map((group) => ({
        file: group.file,
        owner: group.owner,
        tier: group.tier,
        priority: group.priority,
        calls: group.calls,
        evidence: [...group.evidence].join("; "),
      }));
    })
    .toSorted(
      (a, b) =>
        a.tier.localeCompare(b.tier, "en") ||
        a.priority - b.priority ||
        a.owner.localeCompare(b.owner, "en") ||
        a.file.localeCompare(b.file, "en"),
    );
  parser.checkpoint?.("walk-classify");
  return rows;
}

function totals(rows) {
  return {
    files: new Set(rows.map((row) => row.file)).size,
    calls: rows.reduce((sum, row) => sum + row.calls.length, 0),
  };
}

function render(rows) {
  const total = totals(rows);
  const lines = [
    "---",
    'summary: "Generated inventory and migration priorities for synchronous SQLite access"',
    "read_when:",
    "  - Choosing a database worker migration",
    "  - Auditing Gateway main-thread SQLite exposure",
    'title: "Database worker migration inventory"',
    "---",
    "",
    "<!-- Generated by scripts/database-worker-inventory.mjs. Edit its classification evidence, then regenerate. -->",
    "",
    `This snapshot contains **${total.files} non-test files and ${total.calls} call expressions** for the five primitives below. The campaign previously reported 404 files; that is a historical estimate, not a fixed target or a count of call expressions. This inventory follows current source and excludes import-only matches, comments, tests, fixtures, and test support. Its scan scope and exclusions are explicit below.`,
    "",
    "Regenerate with `pnpm db:worker-inventory:gen`; verify with `pnpm db:worker-inventory:check`. `node scripts/database-worker-inventory.mjs --json` emits every call's primitive, line, column, lexical operation path, optional variable-initializer binding, enclosing synchronous guards, file owner, tier, and classification evidence. The script uses the repository's TypeScript parser, entry-point reference graph, and `rg`; it does not load application code or open a database.",
    "",
    "## Scope and interpretation",
    "",
    "T1 is request/event/timer exposure, including conservatively retained runtime or mixed kernels whose callers still need tracing. T1-compat is deprecated-only SDK compatibility and named shared kernels whose only main-thread paths originate at mechanically guarded deprecated APIs. Named worker/maintenance-only kernels are proven through exact reviewed entry points; filename-only leads are not proof roots. Escaped callbacks and returned-method families remain live/unproven. T2 is startup, migration, or a named boot/lock exception candidate. T3 is CLI, Doctor, or developer one-shot code. W marks worker implementations separately: their synchronous SQL is intentional and is not outstanding main-thread debt. A filename-based T2/T3/W classification is an audit lead, not a proof that every caller is safe. Do not move a mixed kernel or a module with ‘worker’ in its name to W without tracing its callers.",
    "",
    "Reviewed mixed modules classify calls by their named lexical operation path, optionally narrowed to a variable initializer or an exact synchronous guard. These qualifiers exclude nested function bodies, and a guard applies only to its then-branch, so unrelated sites remain conservative even when source lines move. Other file tiers retain the broadest applicable counted exposure, including explicit worker/maintenance mixtures. Each file has at most one row per tier; tier file counts overlap, while total files and call expressions are unique. These are not measured runtime call counts. Recheck the operation and all registered callers before changing its classification. Maintenance invoked by Gateway timers remains T1. Prepared results never confer current authority; follow [worker access](/reference/database-schemas/worker-access).",
    "",
    "Canonical-repair mutations and exact-row readers retain T2 for native Doctor callers; Gateway legacy-main detection compares entries and transcript content in the existing session reader worker. Full generation and node-artifact custody fingerprints remain Doctor-only. Shared cleanup kernels retain T1 where released opaque SDK callbacks require native transactions; initialization rollback uses the worker's commit finalizer. Synchronous lifecycle checks and opaque source validators remain native residuals; conversation-bound final effects consume published binding facts. Memory actor category reads use prepared catalog facts; native approval SDK compatibility retains its existing classification. Template provenance's counted writes are CLI-only; its raw Gateway reads remain runtime debt outside the five-primitive scan. Likewise, worker-only direct Cron receipt calls do not classify the host current-authority reads they transitively expose. Reclassification corrects metadata; it does not move runtime SQL or demonstrate a speedup.",
    "",
    "The scan covers JavaScript/TypeScript files under `src/`, `extensions/`, `packages/`, and `scripts/` as selected by `rg` (respecting ignore rules). It recognizes direct calls, property calls with these names, and named-import aliases. It does not resolve higher-order aliases, dynamic dispatch, transitive wrappers, direct `DatabaseSync` methods, other query primitives, or native-language SQLite. It is a reproducible migration queue, not a complete prohibition checker. Tests are deliberately excluded rather than counted as T3.",
    "",
    "| Key | Primitive |",
    "| --- | --- |",
    ...[...primitives].map(([name, key]) => `| ${key} | \`${name}\` |`),
    "",
    "| Tier | Files | Call expressions |",
    "| --- | ---: | ---: |",
    ...["T1", "T1-compat", "T2", "T3", "W"].map((tier) => {
      const count = totals(rows.filter((row) => row.tier === tier));
      return `| ${tier} | ${count.files} | ${count.calls} |`;
    }),
    "",
    "## Profile priority and current cutover status",
    "",
    "Channel ingress `listPending`, `listClaims`, `listFailed`, `listUnsettled`, and claim/recovery preparation share the write broker's FIFO with mutations. They must observe earlier committed writes and retain read-write database admission. Explicit read-only inspection remains noncreating inside that broker. Failed-health, pressure, and account-discovery diagnostics use the read-only worker, where bounded staleness is acceptable.",
    "",
    "The 2026-09-20 five-second Gateway profile on build `ddb31b38a88c` attributed **47% of main-thread time in aggregate** to synchronous state write coordination, including profile creation and exec-approval updates. No separate per-site timing was captured for the read paths below. Their order follows the reported profile triage, not invented individual costs. The T1 table puts these known owners first; all other owners follow alphabetically.",
    "",
    "| Priority | Entry point / owner | Status to verify before a lane |",
    "| --- | --- | --- |",
    "| 1 | `ensureProfileForEmail`; `updateExecApprovals` | Exec policy mutations use the shared-state writer; final SDK authority reads and opaque approval-commit kernels retain their native contract. Profile creation is a separate owner. The 47% is shared, not a measurement of either method alone. |",
    "| 2 | `sessions.list` → `listProjectedSessions` → resident session row projection | Warm requests already reuse resident rows with no host Kysely reads. Hydration, dirty/archived rows, and membership reads remain migration debt; preserve identity-keyed reuse and projection revisions. |",
    "| 3 | `chat.history` → history worker | Ordinary durable pages already use the worker. This cutover moves raw cursor delta reads and JSON parsing through the same owner; display/profile projection, byte budgets, and fresh sharing checks stay on the host. |",
    "| 4 | Transcript search → `session-transcript-search.ts` | The async facade moves durable FTS reads through the existing worker lifecycle for the runtime callers: `sessions-read.ts`, `sessions-search-projected.ts`, and `embedded-gateway-stub.ts`. Callers recheck current scope and authorization after awaiting. |",
    "| 5 | Task/flow registry | Async read facades already use workers; native mutations and mixed kernels remain. Preserve accepted-write fences and projection publication. |",
    "| 6 | Provider catalog → `plugin-model-catalog.ts` | Persisted reads reached from `models-config.ts` and prepared model runtime; keep Doctor imports distinct. |",
    "",
    "The warm `sessions.list` baseline used 5,000 rows, 50 viewers, and 350 calls: **zero host Kysely reads**, **3.07538 ms CPU per call**, and **3.12680 ms amortized wall time per call**. The original per-request store scan was already gone, so this lane does not claim another warm-list database cutover or speedup. These numbers do not cover projection hydration, dirty-row refresh, archived-row materialization, or membership reads.",
    "",
    "The history cutover leaves selected/current session entries, the retained transcript-session key, and lazy subagent source/run-input visibility reads as native work. Ordinary full pages and raw cursor deltas use the history worker. Pending-input source and receipt reads also use workers; synchronous SDK completion remains a separate native path. Bound Claude CLI history now uses its temporary merge index: cold preparation scans bounded source windows, and page/anchor requests project only selected messages. Incognito history comes from the session actor memory backend, which never opens SQLite or uses a database worker. Its CLI-history adapter uses the same matching policy over an in-memory display index. A failed durable worker read never selects the memory backend.",
    "",
    "Durable session reaction summaries and target-message reads use the admitted history worker; reaction writes use the canonical SQLite worker broker with live transaction and commit admission. Incognito reactions use the session actor memory backend. The synchronous reaction kernel now runs only through the admitted durable worker; the native incognito read/write and test-only synchronous production reader paths are removed. Reaction mirroring reads durable source conversation bindings through the history worker, including a final read after account/config preparation and immediately before dispatch; synchronous handoff guards retain live reactor, session, and config checks. The conversation registry's synchronous reader is deprecated SDK compatibility; its shared conversation-query kernel remains T1 for opaque native voice validation. Schemas, stored bytes, retention, and update behavior are unchanged.",
    "",
    '<a id="next-five-independent-lanes" />',
    "",
    "## Next four independent lanes",
    "",
    "After the history-delta/search cutovers and the separate profile/exec-approval lane, inspect these owners. Only catalog reads have a profile-listed position here; the other three are source-backed candidates without separate timings. Device pairing already dispatches through workers, with native boot/Doctor migration exceptions. Measure each actual entry point before choosing its migration.",
    "",
    "| Owner | Concrete caller / boundary |",
    "| --- | --- |",
    "| Persisted provider catalogs | `prepared-model-runtime.facts.ts` and `prepared-model-runtime.scoped-catalog.ts` call `loadPersistedPluginModelCatalogsReadOnly`; prepare catalog bytes off thread without changing registry generations. |",
    "| Operator approval records | `operator-approval-session-events.ts` calls `listPendingOperatorApprovals`; its store also expires/prunes records. Keep fresh resolution and allow-once consumption with the transaction owner. |",
    "| Worker environment inventory | `worker-environments/environment-access.ts` and `prepared-pool.ts` call `store.list`; carry inventory revisions back and revalidate placement/credential authority after waits. |",
    "| Session membership | `session-row-projection-materialize.ts` consumes prepared membership with row facts; sharing publications invalidate the existing projection revision. Incognito membership comes from its memory actor. |",
    "",
    "## Call sites by tier and owner",
    "",
    "Counts use `Q/F/S/A/R` in that order. Source locations are available in `--json`; the first call line below is a navigation hint. Owner labels are source directory boundaries, not CODEOWNERS assignments. Generic runtime candidates require caller evidence before claiming a main-thread defect or a completed migration.",
  ];
  const liveOwners = new Map();
  for (const row of rows.filter((entry) => entry.tier === "T1")) {
    liveOwners.set(row.owner, (liveOwners.get(row.owner) ?? 0) + row.calls.length);
  }
  lines.push(
    "",
    "### Largest live T1 owners",
    "",
    "These are live or unproven call expressions, not measured statements per turn. The T1 table below groups the remaining work by file and lexical API/operation.",
    "",
    "| Owner | Live / unproven calls |",
    "| --- | ---: |",
    ...[...liveOwners]
      .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en"))
      .slice(0, 15)
      .map(([owner, count]) => `| \`${owner}\` | ${count} |`),
  );
  for (const tier of ["T1", "T1-compat", "T2", "T3", "W"]) {
    const showOperations = tier === "T1" || tier === "T1-compat";
    lines.push(
      "",
      `### ${tier}`,
      "",
      `| Owner / file | Calls (Q/F/S/A/R) | First line | ${showOperations ? "API / operation | " : ""}Exposure evidence |`,
      `| --- | ---: | ---: | ${showOperations ? "--- | " : ""}--- |`,
    );
    for (const row of rows.filter((entry) => entry.tier === tier)) {
      const counts = [...primitives.keys()]
        .map((primitive) => row.calls.filter((call) => call.primitive === primitive).length)
        .join("/");
      lines.push(
        `| **${row.owner}** · \`${row.file}\` | ${counts} | ${row.calls[0].line} | ${showOperations ? [...new Set(row.calls.map((call) => call.operation || "(module)"))].map((name) => `\`${name}\``).join(", ") + " | " : ""}${row.evidence} |`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--write", "--check", "--json"].includes(args[0])) {
    console.error("Usage: node scripts/database-worker-inventory.mjs --write|--check|--json");
    process.exitCode = 2;
  } else {
    const rows = inventory();
    if (args[0] === "--json") {
      console.log(
        JSON.stringify(
          {
            totals: totals(rows),
            tiers: Object.fromEntries(
              ["T1", "T1-compat", "T2", "T3", "W"].map((tier) => [
                tier,
                totals(rows.filter((row) => row.tier === tier)),
              ]),
            ),
            files: rows,
          },
          null,
          2,
        ),
      );
    } else {
      const formatted = await format(outputPath, render(rows), { proseWrap: "preserve" });
      if (formatted.errors.length > 0) {
        throw new Error(
          `Inventory Markdown formatting failed: ${JSON.stringify(formatted.errors)}`,
        );
      }
      const rendered = formatted.code;
      const destination = path.join(defaultRoot, outputPath);
      if (args[0] === "--write") {
        fs.writeFileSync(destination, rendered);
        console.log(
          `Wrote ${outputPath}: ${totals(rows).files} files, ${totals(rows).calls} call expressions`,
        );
      } else if (!fs.existsSync(destination) || fs.readFileSync(destination, "utf8") !== rendered) {
        console.error(
          `${outputPath} is stale; run node scripts/database-worker-inventory.mjs --write`,
        );
        process.exitCode = 1;
      } else {
        console.log(`Current: ${outputPath}`);
      }
    }
  }
}
