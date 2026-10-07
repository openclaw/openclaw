#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { format } from "oxfmt";
import * as ts from "typescript/unstable/ast";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
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
const reviewed = new Map([
  [
    "src/gateway/mention-inbox-store.ts",
    {
      priority: 3,
      evidence:
        "Worker-backed bundled callers; deprecated 2026.9.8 synchronous Mention Inbox SDK kernel until next SDK major",
    },
  ],
  [
    "src/gateway/mention-inbox.native.ts",
    {
      priority: 3,
      evidence:
        "Deprecated 2026.9.8 synchronous Mention Inbox SDK transaction; removal at next SDK major",
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
      evidence: "Approval-policy writes; write-coordination cutover owned separately",
    },
  ],
  [
    "src/infra/exec-approvals-store.ts",
    {
      priority: 1,
      evidence: "Approval-policy writes; write-coordination cutover owned separately",
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
      evidence: "Session-list row entries and membership; process-held incognito path",
    },
  ],
  [
    "src/config/sessions/session-accessor.sqlite-entry-read.ts",
    { priority: 2, evidence: "Session-entry read kernel; inspect each caller's execution context" },
  ],
  [
    "src/config/sessions/session-transcript-search.ts",
    {
      priority: 4,
      evidence: "Async durable search uses worker; process-held incognito remains native",
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
    "src/gateway/operator-approval-store.ts",
    { priority: 7, evidence: "Pending-list events, resolution, expiry and pruning" },
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
    { priority: 7, evidence: "Member-row kernel shared by session readers" },
  ],
  [
    "src/config/sessions/session-reaction-store.kernel.ts",
    {
      priority: 99,
      evidence: "Durable reads and writes use workers; incognito keeps its native owner",
    },
  ],
  [
    "src/config/sessions/session-reaction-store.ts",
    {
      priority: 99,
      evidence: "Worker-admitted reaction writes; process-held incognito retains native owner",
    },
  ],
  [
    "src/config/sessions/conversation-registry.ts",
    {
      priority: 99,
      evidence: "Reaction bindings use worker; other synchronous registry callers remain",
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
    "src/infra/gateway-boot-lifecycle.kernel.ts",
    [
      {
        tier: "T2",
        operations: ["inspectGatewayCrashLoopBreakerInDatabase"],
        evidence:
          "Extracted from the existing gateway-boot-lifecycle.ts boot exception. Native inspectGatewayCrashLoopBreaker is only called by cli/gateway-cli/run.ts beginBoot before starting the Gateway; runtime inspection and recovery commit revalidation execute via gatewayBootReadOperations and gateway-boot-lifecycle.worker.ts in the existing state workers.",
      },
    ],
  ],
  [
    "src/state/openclaw-state-db.ts",
    [
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
    "src/config/sessions/session-accessor.sqlite-canonical-repair.ts",
    [
      {
        tier: "T2",
        operations: [
          "ensureSqliteTranscriptGenerationsForCanonicalRepair",
          "rehomeSqliteSessionDeliveryReferencesForCanonicalRepairBatch",
          "copySqliteSessionOwnedStateForRepair",
        ],
        evidence:
          "Doctor canonical-key repair/import; exact-row reader stays T1 via agents.create -> agent-create.ts:238 -> legacy-main-session-migration-claims.ts:101",
      },
    ],
  ],
  [
    "src/claws/provenance.ts",
    [
      {
        tier: "T3",
        operations: [
          "persistClawInstallRecord",
          "updateClawInstallRecordStatus",
          "deleteClawInstallRecord",
          "updateClawInstallRecord",
          "persistClawPackageRef",
          "updateClawPackageRefStatus",
        ],
        evidence:
          "CLI add/update/remove writers; Gateway claws-packages.ts:124 injects worker claimPackageRef; raw Gateway reads remain outside this primitive census",
      },
    ],
  ],
  [
    "src/gateway/worker-environments/placement-session-tool-operations.kernel.ts",
    [
      {
        tier: "W",
        operations: [
          "assertNoRunningWorkerSessionToolOperations",
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
          "placement-store.ts:102 selects only native restart/wait/validation; claim/release/cancel mutations run in placement-turn-claims.worker.ts:102,117,191,200,287,355,360",
      },
      {
        tier: "T2",
        operations: ["createPlacementTurnClaimOps.clearLocalTurnClaimsAfterRestart"],
        evidence: "Only server-worker-environment-startup.ts:177 clears restart claims",
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
          "Only placement-turn-claims.worker.ts:313 publishes staged results; native compatibility readers and pending-result transition guards stay T1",
      },
      {
        tier: "W",
        operations: [
          "hasCurrentWorkspaceResultClaim",
          "clearWorkerWorkspacePendingResult",
          "hasAcceptedWorkerWorkspacePendingResult",
          "insertWorkerWorkspacePendingResult",
          "markWorkerWorkspacePendingResultAccepted",
          "assertPendingClaim",
          "createPlacementWorkspaceResultOps.handoffWorkspaceResultRecovery",
          "createPlacementWorkspaceResultOps.abandonWorkspaceResult",
        ],
        evidence:
          "Mutation factory/helpers run only through placement-turn-claims.worker.ts:102,117,125,132,140,147,157,191,200,278,299,313,326,346; claim read also in placement-read-projection.ts:101 via state-read.worker.ts:666",
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
          "readWorkerPlacementChangeSnapshotInDatabase",
          "readWorkerPlacementsInDatabase",
        ],
        evidence:
          "Snapshots use openclaw-state-read.worker.ts; placement-lifecycle.worker.ts serves point lookups on the existing placement actor. Native reconciliation guards remain T1.",
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
          "placement-dispatch-store.worker.ts:38 and placement-turn-claims.ts:112 claim path; claims only invoked at placement-turn-claims.worker.ts:160,175,345. Native placement-store.ts:75,76 selects clear/wait/validate methods that do not claim.",
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
          "updateSidebarOrder",
          "mutateSessionGroupCatalogInDatabase",
        ],
        evidence:
          "state-read.worker.ts:334 and state-worker-runtime.ts:222; readSessionGroupCatalogEntry stays T1 for native incognito categories",
      },
    ],
  ],
  [
    "src/gateway/operator-approval-store.kernel.ts",
    [
      {
        tier: "W",
        operations: ["listTerminalOperatorApprovalsInDatabase"],
        evidence:
          "Only openclaw-state-read.worker.ts:489 serves approval history; the native compatibility operation map has no history operation",
      },
      {
        tier: "W",
        operations: ["insertOperatorApprovalInDatabase", "listPendingOperatorApprovalsInDatabase"],
        evidence:
          "exec-approval-manager.ts:125 insert and operator-approval-session-events.ts:194 pending supply no native guard; operator-approval-store.ts:138,173 selects worker dispatch to operator-approval-store.operations.ts:57,65 via state/openclaw-state-worker-registry.ts:119. Other approval operations retain native compatibility.",
      },
    ],
  ],
  [
    "src/gateway/operator-approval-store.transitions.ts",
    [
      {
        tier: "T2",
        operations: ["closeOrphanedOperatorApprovals", "pruneTerminalOperatorApprovals"],
        evidence:
          "Boot calls only in server-aux-handlers.ts:105,109; remaining transitions retain native SDK compatibility",
      },
      {
        tier: "W",
        operations: [
          "expireDueOperatorApprovalsInDatabase",
          "consumeOperatorApprovalAllowOnceInDatabase",
        ],
        evidence:
          "operator-approval-session-events.ts:178 expiry and exec-approval-manager.ts:644 consume supply no native guard; operator-approval-store.ts:173 -> operator-approval-store.operations.ts:85,89 worker dispatch. Expiry also runs from worker-only pending kernel at operator-approval-store.kernel.ts:233.",
      },
    ],
  ],
  [
    "src/infra/push-web-store.kernel.ts",
    [
      {
        tier: "W",
        operations: [
          "findBoundWebPushSubscriptionByEndpointInDatabase",
          "listWebPushSubscriptionsInDatabase",
          "hasBoundWebPushSubscriptionsInDatabase",
          "listBoundWebPushSubscriptionsInDatabase",
          "prepareWebPushApprovalDeliveriesInDatabase",
          "listWebPushApprovalDeliveryTargetsInDatabase",
          "deleteWebPushApprovalDeliveryTargetsInDatabase",
          "listTerminalWebPushApprovalDeliveryIdsInDatabase",
          "deleteWebPushSubscriptionIfCurrentInDatabase",
        ],
        evidence:
          "Only push-web-store.worker.ts:14,20,22,24,28,32,36,40,62 calls these operations; native preferences/upsert/delete-bound and their shared schema helper stay T1",
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
          "Only sessionUpstream.listWatched dispatches this read; mutation kernels retain v2026.9.8 synchronous SDK callers until the next Plugin SDK major.",
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
        operations: ["recordSessionStateEventInDatabase"],
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
          "requireSelectedSkillLibraryUpload",
          "selectSkillLibraryEntries",
          "selectSkillLibraryRevision",
          "selectSkillLibraryRevisionMetadata",
          "assertSkillLibraryNameAvailable",
          "recordSkillLibraryEvent",
        ],
        evidence:
          "Library row, revision, upload, and mutation kernels run only through the shared-state reader/writer; the SDK metadata batch remains in selection-read.kernel.ts",
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
    "src/secrets/store/secret-store.ts",
    [
      {
        tier: "T3",
        operations: ["updateSecretStoreAllowedHosts"],
        evidence:
          "Only cli/secrets-store-cli.ts:251 mutates allowed hosts; runtime reads and other writes remain T1",
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
        ],
        evidence:
          "Only openclaw-state-worker-runtime.ts calls these ordinary secret mutation kernels",
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
        operations: [
          "readActiveCronRunReceiptOwnersInDatabase",
          "readActiveCronRunReceiptsInDatabase",
        ],
        evidence:
          "read-command.ts currentReceipt/activeReceiptOwners and run-recovery.read.ts route through openclaw-state-read.worker.ts; remaining direct callers are run-admission.worker.ts and runtime-maintenance.worker.ts",
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
        ],
        evidence:
          "Cron worker kernels or Doctor legacy-repair.ts:395 transactionHooks / store-repair.ts:178 / doctor-heartbeat-task-migration.ts:261,308; the native current-job reader was deleted; standing-generation reads stay T1",
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
    "src/agents/workspace-state-store.ts",
    [
      {
        tier: "T2",
        operations: ["retireWorkspaceRelocationAttestation"],
        evidence:
          "Only commands/doctor-skill-workshop-workspaces.ts:266 retires migration attestations",
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
        ],
        evidence:
          "Worker runtime/read dispatch plus Doctor workspace-alias-rebind.ts:83,324, migration workspace-setup-store.ts:528 and relocation retirement workspace-state-store.ts:256; native identity/deletion stay T1",
      },
      {
        tier: "W",
        operations: ["replaceWorkspaceAttestationInDatabase"],
        evidence:
          "workspace.replaceAttestation dispatch in openclaw-state-worker-runtime.ts:212; shared snapshot/alias helpers retain Doctor/migration exposure",
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
          "Preference read/write dispatch at user-preferences.worker.ts:52,74; merge/GitHub helpers only in user-profile-writes.worker.ts:325,375,432 and openclaw-state-read.worker.ts:616; private key scans serve these worker writers",
      },
    ],
  ],
  [
    "src/state/user-profile-identity.read.ts",
    [
      {
        tier: "W",
        operations: [
          "readUserProfileEmailBindings",
          "readUserProfileSnapshotSync",
          "readUserProfileAuthorityInDatabase",
        ],
        evidence:
          "Only registered user-profile-writes.worker.ts:126,187 / user-profiles.worker.ts:110,111 and state-read.worker.ts:566,592,605 call these readers; projects.ts:432 native aliases and admission fallbacks stay T1",
      },
    ],
  ],
  [
    "src/state/agent-deletion-journal.ts",
    [
      {
        tier: "T2",
        operations: ["prepareAgentDeletionPathFence"],
        evidence:
          "Pre-open registration/schema/lease admission at openclaw-agent-db-registry.ts:79, schema.ts:519 and lease.ts:161,495,699; runtime journal mutation/fence reads stay T1",
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
        operations: ["copySqliteSessionGenerationRows"],
        evidence:
          "Doctor cross-store repair: legacy-main-session-migration-operations.ts:324 is gated by doctor-fix at :550; session-accessor.sqlite-canonical-repair.ts:504 is called by commands/doctor-session-canonical-keys.ts:454. Gateway agents.create detect mode does not copy.",
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
        tier: "T2",
        operations: ["deleteSessionMembersForRepair"],
        evidence:
          "Only commands/doctor-session-canonical-keys.ts:311 and session-accessor.sqlite-canonical-repair.ts:513 call this member cleanup; the latter is Doctor repair via doctor-session-canonical-keys.ts:454.",
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
    ],
  ],
  [
    "src/config/sessions/session-accessor.sqlite-transcript-write.ts",
    [
      {
        tier: "T3",
        operations: ["replaceTranscriptEvents"],
        evidence:
          "Only production invocations are developer benchmarks scripts/bench-agent-database-holds.ts:142 and scripts/bench-session-history.ts:383; remaining references are internal reexports and excluded test helpers. Synchronous replacement is separately retained.",
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
        operations: ["setCanonicalSqliteSessionMainKey"],
        evidence:
          "Only startup-migration.ts:291 boot admission and commands/doctor-session-canonical-keys.ts:438,518 repair call this setter; other canonical-key runtime operations stay T1.",
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
        ],
        evidence:
          "Only session-accessor.sqlite-mutation-worker.runtime.ts:375,280,381 calls these operations in the mutation-worker message handler. Shared host readiness hasPendingCanonicalSessionValidation stays T1.",
      },
    ],
  ],
  [
    "src/config/sessions/session-cold-storage-backup.ts",
    [
      {
        tier: "T3",
        operations: ["embedSessionColdArchivesInSnapshot"],
        evidence:
          "infra/backup-sqlite-snapshot.ts:292 via backup-create.ts:320,332,352; snapshot/openclaw-snapshot-copy.ts:72 via local-repository.ts:148 and git-backup.ts:310. Roots are commands/backup.ts:52, backup-sqlite.ts:80, backup-git.ts:131, Doctor/update backup and developer reliability scripts; SQL targets a temporary snapshot.",
      },
    ],
  ],
  [
    "src/gateway/config-revision-token.ts",
    [
      {
        tier: "T2",
        operations: ["loadOrCreateConfigRevisionKey", "loadGatewayConfigRevisionKey"],
        evidence:
          "Gateway construction at server-kernel-request-runtime.ts:48; local-request-context.ts:107 also initializes it via agents/agent-command-local.ts:61 for standalone commands/boot. Existing Gateway scopes return before local allocation at local-request-context.ts:237. Request hashing captures the key and performs no SQL.",
      },
    ],
  ],
  [
    "src/gateway/github-personal-publication-store.ts",
    [
      {
        tier: "T2",
        operations: ["requirePersonalGitHubPublicationConfirmation"],
        evidence:
          "Only github-publication-runtime.ts:18 during construction by server-worker-placement-startup.ts:90, reached from server-runtime-state-prepare.ts:181. Periodic reconcilePublications never calls the fence.",
      },
    ],
  ],
  [
    "src/gateway/operator-approval-standing-grants.ts",
    [
      {
        tier: "W",
        operations: ["lookupCronStandingGrantInDatabase", "consumeCronStandingGrantInDatabase"],
        evidence:
          "Only openclaw-state-read.worker.ts validates and operator-approval-store.operations.ts consumes through the existing workers; bash-tools.exec-cron-grant.ts awaits operator-approval-store.ts while retaining the Gateway authority interval. No native lookup/consume facade remains.",
      },
      {
        tier: "W",
        operations: ["listCronStandingGrantsInDatabase"],
        evidence:
          "Only state/openclaw-state-read.worker.ts:495; server-methods/exec-approval.ts:462 -> operator-approval-store.ts:273 uses readApprovalStore -> executeExistingOpenClawStateRead at :248 even when a guard exists.",
      },
    ],
  ],
  [
    "src/gateway/operator-approval-store.rows.ts",
    [
      {
        tier: "W",
        operations: ["hasApprovalLocatorNamespaceConflict"],
        evidence:
          "Only operator-approval-store.kernel.ts:98 insert calls it. Sole facade caller exec-approval-manager.ts:125 passes assertCurrent but no native guard, so operator-approval-store.ts:173 dispatches the registered worker operation.",
      },
    ],
  ],
  [
    "src/gateway/worker-environments/placement-move-intent.ts",
    [
      {
        tier: "W",
        operations: ["readWorkerPlacementMovesReadOnly"],
        evidence:
          "Only placement-dispatch-store.worker.ts:69, placement-turn-claims.worker.ts:72 and placement-read-projection.ts:85 call the batch reader; projection itself is only called by state/openclaw-state-read.worker.ts:670. Native getPlacementMove uses another reader.",
      },
      {
        tier: "W",
        operations: [
          "deleteExactMove",
          "requireExactAttachedEnvironment",
          "createPlacementMoveOps.completeSourceToLocal",
          "createPlacementMoveOps.beginPlacementMove",
          "createPlacementMoveOps.recordPlacementMoveError",
        ],
        evidence:
          "Only placement-lifecycle.worker.ts invokes move mutations; placement-store.ts retains only the native getPlacementMove getter for final effect guards.",
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
    "src/gateway/worker-environments/placement-workspace-reservation.kernel.ts",
    [
      {
        tier: "W",
        operations: ["assertSessionWorkspaceUnreserved"],
        evidence:
          "placement-dispatch-store.worker.ts:39 and placement-turn-claims.ts:93 claim path; claims only invoked at placement-turn-claims.worker.ts:160,175,345. Native placement-store.ts:75,76 selects clear/wait/validate methods.",
      },
    ],
  ],
  [
    "extensions/memory-core/src/memory-session-tombstones.ts",
    [
      {
        tier: "W",
        operations: ["recordMemorySessionTombstonesInDatabase", "hasMemorySessionTombstone"],
        evidence:
          "memory-entry-origins.worker.ts -> memory-forget-kernel.ts owns tombstone writes; manager-publication.worker.ts owns every hasMemorySessionTombstone call, including the session.current predicate retained under workspace custody for shadow publication.",
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
          "Only manager.ts:546 calls the storage query, gated by sourceInspections populated through inspectSources at manager.ts:182. Explicit diagnostic callers are cli-status.runtime.ts:218, cli-index-search.runtime.ts:73,214, and src/commands/status.scan.shared.ts:474; ordinary Gateway status does not request inspection.",
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
        ],
        evidence:
          "Registry mutations, including reservation and removal-intent selection, run only through registry-write.worker.ts -> executeSandboxRegistryCommand; import only registry-import.worker.ts. List helpers run through openclaw-state-read-registry.ts in the read worker. The row reader remains T1 for released synchronous sandbox callbacks held across provider waits and deferred process launch; see worker-access.md.",
      },
    ],
  ],
  [
    "src/agents/subagents/registry/subagent-registry.store.kernel.ts",
    [
      {
        tier: "W",
        operations: ["conflictingSubagentRunVersions", "writeSubagentRunValuesInDatabase"],
        evidence:
          "Registry persistence and completion admission workers invoke the conflict and batch write kernels. Completion mutation writes are reached only through the admission worker; no native writer caller remains.",
      },
    ],
  ],
  [
    "src/agents/subagents/registry/subagent-registry.store.sqlite.ts",
    [
      {
        tier: "W",
        operations: ["readSubagentRunRow", "readSubagentSessionListRows"],
        evidence:
          "Row reads are only completion/subagent-completion-admission.worker.ts:94,155 or its mutation kernel at :246,274,293,412,523,562,576 (admission.worker.ts:188). Session-list loader at store.sqlite.ts:409 is called only by src/state/openclaw-state-read.worker.ts:196; other native registry readers remain T1.",
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
          "Only src/commands/doctor-workspace-alias.ts:67,107,131 invokes detect/rebind; readWorkspaceMoveState is private at :166,282. Doctor health/lint reaches detection via src/flows/doctor-health-contributions-final.ts:269 and doctor-health-contribution-runners.workspace.ts:77; repair is installed by src/commands/doctor-config-flow.ts:83,93.",
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
          "getRegistryWorktreeProvisionedChunkInDatabase",
        ],
        evidence:
          "Runtime reads and exact-row predicates use worktrees/dispatch.worker.ts and registry-run-end.worker.ts through the shared-state worker registry. Cleanup inventory uses openclaw-state-read-registry.ts in the read worker. Native fixture readers live only in registry.test-support.ts; Doctor migration lists keep their separate registry.ts queries.",
      },
    ],
  ],
  [
    "src/agents/worktrees/registry.ts",
    [
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
        tier: "W",
        operations: ["readWorktreeRunLeaseStateInDatabase", "assertRegistryMutationCustody"],
        evidence:
          "Run-lease inventory is dispatched by openclaw-state-read-registry.ts in the read worker. Registry mutation custody is called only by registry-run-end.worker.ts. The actual lease read/reap primitives remain synchronous exemptions.",
      },
    ],
  ],
  [
    "src/agents/worktrees/run-lease-store.kernel.ts",
    [
      {
        tier: "W",
        operations: ["admitWorktreeRunLeaseInDatabase"],
        evidence:
          "Only worktrees/dispatch.worker.ts:50 registers admission through run-lease-store.worker.ts:6; src/state/openclaw-state-worker-registry.ts:149 loads the handler. Shared release/lease cleanup remain T1.",
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
          "inspectAcpSessionClaimsForDoctor",
          "updateAcpSessionIdentityForDoctor",
        ],
        evidence:
          "Doctor repair: src/commands/doctor-session-transcripts.ts:318. Plugin Doctor context: src/infra/state-migrations.plugin-doctor-context.ts:403,463, constructed by state-migrations.plugin-doctor.ts:200,325.",
      },
    ],
  ],
  [
    "src/acp/runtime/session-meta-keys.ts",
    [
      {
        tier: "W",
        operations: ["selectAcpSessionRows"],
        evidence:
          "src/acp/runtime/session-meta-list.ts:21 submits acpSessions.list → src/state/openclaw-state-read.worker.ts:264.",
      },
    ],
  ],
  [
    "src/claws/cron.ts",
    [
      {
        tier: "T3",
        operations: ["persistPendingRef", "updateRef", "deleteClawCronRef", "upsertClawCronRef"],
        evidence:
          "CLI add/update/remove only: src/cli/claws-cli.ts:115,152,181 → add.ts:585, update-apply.ts:541 and lifecycle-state.ts:555,557 → cron.ts/cron-update.ts.",
      },
    ],
  ],
  [
    "src/claws/lifecycle-config-removal.ts",
    [
      {
        tier: "T3",
        operations: ["withClawAgentConfigRemoval"],
        evidence:
          "src/cli/claws-cli.runtime.ts:562 invokes removal → src/claws/lifecycle-state.ts:489 (sole caller).",
      },
    ],
  ],
  [
    "src/claws/lifecycle-delete-support.ts",
    [
      {
        tier: "T3",
        operations: ["releaseClawRemoveRows"],
        evidence:
          "src/cli/claws-cli.runtime.ts:562 invokes removal → src/claws/lifecycle-state.ts:650 (sole caller).",
      },
    ],
  ],
  [
    "src/claws/mcp.ts",
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
          "CLI add/update/remove only: src/cli/claws-cli.ts:115,152,181 → add.ts:568,570, update-apply.ts:410 and lifecycle-state.ts:506 → mcp.ts/mcp-update.ts/lifecycle-mcp-removal.ts.",
      },
    ],
  ],
  [
    "src/claws/package-status.kernel.ts",
    [
      {
        tier: "T3",
        operations: ["updateClawPackageRefStatusInDatabase"],
        evidence:
          "CLI add: src/claws/add.ts:264 → packages.ts:316,395,567,579,656 → provenance.ts:488; worker sibling provenance-write.worker.ts:81.",
      },
    ],
  ],
  [
    "src/claws/package-update-provenance.ts",
    [
      {
        tier: "T3",
        operations: ["replaceClawPackageRefExpected"],
        evidence:
          "CLI update: src/cli/claws-update-cli.runtime.ts:175 → src/claws/update-apply.ts:300,322 → package-update.ts:59,98,99,182,183,228,234,254.",
      },
    ],
  ],
  [
    "src/claws/provenance-read.kernel.ts",
    [
      {
        tier: "W",
        operations: ["readClawOrphanWorkspaceInDatabase"],
        evidence:
          "Only src/state/openclaw-state-read.worker.ts:232 and src/claws/provenance-write.worker.ts:48 execute the reader.",
      },
    ],
  ],
  [
    "src/claws/workspace.ts",
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
          "CLI add: src/claws/add.ts:509,511 → workspace.ts:376,408,417,419,427,432; CLI update: update-apply.ts:398 → workspace-update.ts:115,121,171,173,177.",
      },
    ],
  ],
  [
    "src/cron/scratch-read.kernel.ts",
    [
      {
        tier: "T3",
        operations: ["readScratchStateFromDatabase", "readHeartbeatMonitorScratchFromDatabase"],
        evidence:
          "Doctor-only native reads: src/commands/doctor-heartbeat-scratch-migration.ts:516,567,588 and doctor-heartbeat-task-migration.ts:94,411 → scratch-store.ts:33,42,52. Worker sibling src/cron/store/read-command.ts:54.",
      },
    ],
  ],
  [
    "src/cron/scratch-store.ts",
    [
      {
        tier: "T3",
        operations: ["deleteCronJobScratch"],
        evidence:
          "Sole native caller src/commands/doctor-heartbeat-scratch-migration.ts:625: revision-guarded migration compensation.",
      },
    ],
  ],
  [
    "src/cron/scratch-write.kernel.ts",
    [
      {
        tier: "T3",
        operations: ["writeCronJobScratchInDatabase", "writeCronJobScratchForMaintenance"],
        evidence:
          "Doctor migration/compensation at src/commands/doctor-heartbeat-scratch-migration.ts:570,617; worker sibling src/cron/store/scratch.worker.ts:28.",
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
        operations: ["terminalizeBoundDeliveryQueueEntry", "pruneOrdinaryDeliveryReceipts"],
        evidence:
          "Native migration: src/infra/outbound/delivery-queue-migration.ts:308; schema backfill: src/state/openclaw-state-db-delivery-queue-backfill.ts:93. Other terminalization/pruning callers are delivery-queue.worker.ts:117,316,387,457 and session-delivery-queue.worker.ts:264.",
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
          "expireStagingAndLoadDeliveryQueueEntriesInDatabase.read",
          "countFailedDeliveryQueueEntriesInDatabase",
        ],
        evidence:
          "Expiry snapshot: src/infra/delivery-queue.worker.ts:487 → outbound/delivery-queue-media-staging.kernel.ts:74. Failed count: delivery-queue.worker.ts:455.",
      },
      {
        tier: "T2",
        operations: ["loadDeliveryQueueEntriesInDatabase", "deleteDeliveryQueueEntryInDatabase"],
        evidence:
          "Native loads/deletes are Doctor migration: src/commands/doctor-outbound-delivery.ts:47,48,52,137,162 and src/infra/outbound/delivery-queue-migration.ts:289,349,435,506,528,551. Remaining calls use queue workers.",
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
          "Live callers use device-identity-async.ts through openclaw-state.worker.ts. Native callers are startup-local-cli-pairing.ts (server-runtime-state-prepare boot), node-host/runner.ts and startup-state-readiness.ts (node boot/connect CLI), config-preflight-snapshot.ts, doctor-device-pairing.ts, heartbeat-schedule.ts (Doctor cadence migration only), and state-migrations.device-identity*.ts (Doctor).",
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
        tier: "T3",
        operations: ["deleteExecApprovalsConfigRow"],
        evidence:
          "src/cli/exec-policy-cli.ts:405 → src/infra/exec-approvals-store.ts:431 restores an absent row after CLI config-write failure.",
      },
    ],
  ],
  [
    "src/infra/exec-approvals-store.ts",
    [
      {
        tier: "T3",
        operations: ["restoreExecApprovalsSnapshotLocked"],
        evidence:
          "Only src/cli/exec-policy-cli.ts:405 restores the snapshot after CLI config-write failure.",
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
          "createPackageActivationJournal",
          "createPackageActivationJournal.verifyPrivate",
        ],
        evidence:
          "CLI admission/status: src/cli/update-cli/update-command-run.ts:208, status.ts:240. Guarded swap: update-command-package.ts:542,645 → src/infra/package-update-swap.ts:342,356 → package-update-activation-prepare.ts:189,298; standalone recovery package-update-activation-sealed.ts:39,62,63.",
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
        tier: "T3",
        operations: [
          "consumeGatewayRestartHandoffSync",
          "consumeGatewayRestartHandoffSync.removeCurrent",
        ],
        evidence:
          "Only CLI gateway-cli/register-restart-handoff.ts:61 calls consumeGatewayRestartHandoffSync and its private removeCurrent helper; shared row reader also runs at Gateway boot and remains T1.",
      },
    ],
  ],
  [
    "src/infra/restart-intent.ts",
    [
      {
        tier: "T3",
        operations: ["writeGatewayRestartIntentForTargetSync"],
        evidence:
          "CLI lifecycle src/cli/daemon-cli/lifecycle-restart-intent.ts:68,75, lifecycle-unmanaged.ts:131; update stop src/daemon/launchd-stop.ts:219,271; QA suite-runtime-gateway.ts:262. Gateway system-agent uses host.request (operations-execute.ts:601,608), not daemon lifecycle.",
      },
    ],
  ],
  [
    "src/infra/restart-sentinel-store.ts",
    [
      {
        tier: "T3",
        operations: ["writeRestartSentinelRowIfRevisionSync"],
        evidence:
          "src/infra/restart-sentinel.worker.ts:74,150 plus generated one-shot child in src/infra/update-managed-service-handoff.ts:101,439,1639,1649.",
      },
      {
        tier: "W",
        operations: ["deleteRestartSentinelRowSync"],
        evidence:
          "Only src/infra/restart-sentinel.worker.ts:79; worker registration src/state/openclaw-state-worker-registry.ts:110.",
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
        ],
        evidence:
          "Native entries/upsert serve state-migrations.audit-checkpoints.ts, audit-recovery.ts, audit-logs.ts and CLI audit-backup.ts. Native latest serves readRecentConfigAuditRecords in Doctor config flow and update-immutable-protection.ts. Transcript/greeting reads and CAS, plus config-journal snapshots, use the existing workers. Native config observation still reaches register/count/next/prune, which remain T1.",
      },
    ],
  ],
  [
    "src/infra/update-candidate-state.ts",
    [
      {
        tier: "T3",
        operations: ["collectRegisteredPaths"],
        evidence:
          "CLI backup src/cli/update-cli/update-command-database-backup.ts:104 → src/infra/update-database-backup.ts:387; baseline update-command-initialization-run.ts:224 → update-recovery-baseline-capture.ts:343; worker inventory modes update-candidate-state.worker.ts:49,68,73.",
      },
      {
        tier: "W",
        operations: ["snapshotUpdateCandidateState.transform"],
        evidence:
          "Snapshot sole executor src/infra/update-candidate-state.worker.ts:63 (isolated candidate child).",
      },
    ],
  ],
  [
    "src/infra/update-run-ledger.ts",
    [
      {
        tier: "T3",
        operations: ["createUpdateRun"],
        binding: "active",
        evidence:
          "active initializer requires stale-run opt-in only from src/cli/update-cli/update-command-run.ts:304,310,313; guard src/infra/update-run-ledger.ts:127 excludes Gateway/campaign callers. Repairs: update-repair-command.ts:141; interruption: update-command-mutable-signals.ts:158.",
      },
      {
        tier: "T3",
        operations: ["reconcilePackageOwnerRefusal", "finishInterruptedUpdateBeforeActivation"],
        evidence:
          "active initializer requires stale-run opt-in only from src/cli/update-cli/update-command-run.ts:304,310,313; guard src/infra/update-run-ledger.ts:127 excludes Gateway/campaign callers. Repairs: update-repair-command.ts:141; interruption: update-command-mutable-signals.ts:158.",
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
        operations: ["updateChannelPairingStateSnapshot"],
        evidence:
          "Only src/infra/state-migrations.channel-pairing.ts:314,348 invokes the snapshot transaction; registered by state-migrations.doctor.ts:1527.",
      },
    ],
  ],
  [
    "src/secrets/store/secret-store-hidden-github.ts",
    [
      {
        tier: "W",
        operations: ["writePersonalGitHubSecret"],
        evidence:
          "Counted expression is null DELETE only: src/state/user-github-connections.ts:260 → user-profiles-merge.ts:58 → user-profile-writes.worker.ts:325,375,432. Other value callers pass JSON strings.",
      },
    ],
  ],
  [
    "src/skills/workshop/store-sqlite-record.ts",
    [
      {
        tier: "T3",
        operations: ["readStoredProposalInDatabase", "updateProposal"],
        evidence:
          "Doctor native read/update src/commands/doctor-skill-workshop-sqlite.ts:333,349; other callers use src/skills/workshop/store.worker.ts:68,129,149,167,182,188.",
      },
      {
        tier: "W",
        operations: ["insertProposal"],
        evidence:
          "Only src/skills/workshop/store-proposal.kernel.ts:73,168 inserts; sole executors store.worker.ts:139,157.",
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
          "src/state/openclaw-state-read-registry.ts:65 under read worker :679; other executor src/state/openclaw-agent-execution.worker.ts:190.",
      },
    ],
  ],
  [
    "src/state/agent-provenance.kernel.ts",
    [
      {
        tier: "W",
        operations: ["listAgentProvenanceInDatabase"],
        evidence:
          "src/state/agent-provenance.ts:114 submits agentProvenance.list → openclaw-state-worker-runtime.ts:277.",
      },
    ],
  ],
  [
    "src/state/config-machine-state-write.ts",
    [
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
    "src/state/openclaw-agent-canonical-validation-receipt.ts",
    [
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
        operations: ["repairOpenClawAgentDatabasePathAliases"],
        evidence:
          "src/commands/doctor-agent-database-paths.ts:24 under Doctor repair; registered health runner src/flows/doctor-health-contribution-runners.state.ts:122.",
      },
    ],
  ],
  [
    "src/state/openclaw-agent-db-registry.ts",
    [
      {
        tier: "T3",
        operations: ["unregisterOpenClawAgentDatabases"],
        evidence:
          "Plural unregister: CLI claw removal src/claws/lifecycle-delete-support.ts:519 → cli/claws-cli.runtime.ts:562; CLI agent deletion src/commands/agents.commands.delete.ts:450 → cli/program/register.agent.ts:183.",
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
          "Only src/state/user-profiles-merge.ts:57, executed by user-profile-writes.worker.ts:325,375,432.",
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
          "prepareUserProfileGitHubMerge",
          "readGitHubIdentityBinding",
          "selectGitHubProfileAlias",
          "applyVerifiedGitHubIdentity",
          "applyVerifiedGitHubIdentity.writeIdentity",
        ],
        evidence:
          "Read dispatcher src/state/openclaw-state-read.worker.ts:577; mutations user-profile-writes.worker.ts:424,432 and merges :325,375. ensureEmail path user-profiles.worker.ts:61; private writeIdentity only from applyVerifiedGitHubIdentity; private selectGitHubProfileAlias only from readGitHubIdentityBinding and the read-worker cached-binding command (openclaw-state-read.worker.ts:520).",
      },
    ],
  ],
  [
    "src/state/user-profiles-internal.ts",
    [
      {
        tier: "W",
        operations: [
          "insertUserProfile",
          "selectUserProfileEmailAlias",
          "setUserProfileEmailBinding",
          "readProfileAvatarInDatabase",
        ],
        evidence:
          "Creation/link/merge/sync calls flow through src/state/user-profiles.worker.ts:61,69,71 and user-profile-writes.worker.ts:325,350,359,375,430; identity/avatar reads dispatch only from openclaw-state-read.worker.ts:577,604,631.",
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
          "Only src/state/user-profile-writes.worker.ts:325,375,432 executes mergeUserProfiles.",
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
        tier: "T3",
        operations: ["loadSqliteTrajectoryRuntimeEventRowsSync"],
        binding: "countRow",
        evidence:
          "Only CLI export supplies maxEventCount: src/cli/program/register.status-health-sessions.ts:431 → commands/export-trajectory.ts:158 → trajectory/command-export.ts:80 → trajectory/export.ts:415,420. Keep polling/payload expressions T1.",
      },
    ],
  ],
  [
    "src/transcripts/store-read.ts",
    [
      {
        tier: "W",
        operations: ["readLatestTranscriptEntry"],
        evidence:
          "src/transcripts/store.ts:250 submits transcripts.latest → src/state/openclaw-state-worker-runtime.ts:188 → src/transcripts/store-worker-read.ts:94; other reference is ReturnType only.",
      },
    ],
  ],
]);
const workerModules = new Set([
  "src/gateway/worker-environments/local-workspace-store.kernel.ts", // Projection read/write workers and worktree retirement worker only.
  "src/skills/library/import.kernel.ts", // Upload commands execute only in the shared-state writer.
  "src/skills/library/service.kernel.ts", // Library catalog and revision reads use the shared-state read registry.
  "src/config/sessions/conversation-delivery-store.kernel.ts", // Agent execution registry writes and session transcript worker reads only.
  "extensions/memory-core/src/memory-entry-origin-reads.ts", // Memory search worker origin-read commands only.
  "extensions/memory-core/src/memory-entry-origins-delete.ts", // Memory origin worker delete command only.
  "extensions/memory-core/src/memory-forget-index-read.ts", // Memory search worker forget-index-plan command only.
  "extensions/memory-core/src/memory-forget-kernel.ts", // Memory origin worker forget mark and purge commands only.
  "extensions/memory-core/src/standing-intents-kernel.ts", // Standing-intent worker command dispatcher only.

  "extensions/memory-core/src/memory/manager-embedding-cache.ts", // Cache SQL, including iterator reads, is called only by manager-publication.worker.ts.
  "extensions/memory-core/src/memory/manager-source-index-kernel.ts", // Hash reads and source mutations are called only by manager-publication.worker.ts.

  "extensions/workboard/src/sqlite-store-kernel.ts", // Workboard SQLite worker backend factory only.
  "extensions/workboard/src/sqlite-store-sessions-board.ts", // Workboard worker kernel sessions-board store only.
  "extensions/workboard/src/sqlite-store-write.ts", // Workboard worker kernel card writes only.

  "packages/memory-host-sdk/src/memory-entry-origins.ts", // Private memory SDK origin queries serve search and origin workers only.

  "src/agents/mcp-oauth-store.kernel.ts", // MCP OAuth write dispatcher and shared-state read worker only.
  "src/agents/harness/native-hook-relay-store.kernel.ts", // native-hook-relay-store.worker.ts owns runtime SQL; clear is test-only.

  "src/agents/subagents/completion/subagent-completion-queue-receipt.ts", // Completion mutation kernel runs through the session-delivery worker.

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

  "src/config/sessions/session-accessor.sqlite-archive-selection.ts", // Archive worker read-page selection only.
  "src/config/sessions/session-accessor.sqlite-mutation-worker.runtime.ts",
  "src/config/sessions/session-accessor.sqlite-summary.ts", // Only session-transcript.worker.ts dispatches the summary kernel at runtime.
  "src/config/sessions/session-accessor.sqlite-transcript-binding.ts", // History worker transcript-binding reader only.
  "src/config/sessions/session-cold-storage-selection.ts", // Cold preparation and mutation kernels in session-cold-storage-worker.ts only.
  "src/config/sessions/session-cold-storage-worker.ts", // Archive worker cold-prepare and cold-mutate dispatchers only.
  "src/config/sessions/session-membership-facts.ts", // Transcript worker session-membership-facts dispatcher only.

  "src/cron/store/run-history.kernel.ts", // Cron read worker and shared-state Cron dispatch own history SQL.
  "src/cron/store/job-name.kernel.ts", // Shared-state/history workers and Doctor transaction hooks only.
  "src/cron/store/run-receipt-delivery.ts", // Cron admission and recovery workers own delivery-attempt SQL.
  "src/cron/store/run-receipt-trigger-state.ts", // Cron mutation, admission and recovery workers own trigger retirement SQL.

  "src/fleet/registry.kernel.ts", // Fleet write dispatcher and shared-state registry read worker only.

  "src/gateway/github-publication-shared-read.kernel.ts", // Shared publication queries are called only by the state read worker.
  "src/gateway/managed-image-record-store.kernel.ts", // Shared-state worker dispatch only; host exports are row codecs.
  "src/gateway/operator-approval-store.receipts.ts", // Audit read worker alone reaches receipt readers through the approval-store barrel.
  "src/gateway/session-group-registration.kernel.ts", // Session-group registration runs through shared-state worker dispatch.
  "src/gateway/session-history-worker-reader.ts", // Only session-transcript.worker.ts dispatches history metadata reads.

  "src/gateway/worker-environments/inference-store.kernel.ts", // Inference worker dispatcher creates this kernel only.
  "src/gateway/worker-environments/placement-read-projection.ts", // Shared-state read worker placement projection and recovery dispatchers only.
  "src/gateway/worker-environments/session-attachment-store.ts", // Environment worker kernel and read-worker attachment facts only.
  "src/gateway/worker-environments/store-mutations.ts", // Environment worker kernel, transitions, and initialization only.
  "src/gateway/worker-environments/store-row-codec.ts", // Environment and placement workers plus shared-state read-worker facts only.
  "src/gateway/worker-environments/store-transitions.ts", // Environment worker kernel owns transition operations only.
  "src/gateway/worker-environments/store-write.ts", // Environment worker mutation receipt change counts only.
  "src/gateway/worker-environments/store.kernel.ts", // Environment worker dispatcher creates this kernel only.
  "src/gateway/worker-environments/terminal-environment-retention.ts", // Read-worker prune pages and environment worker pruning only.

  "src/infra/device-auth-store.kernel.ts", // Shared-state worker SQL; pairing token retirement is supplied only by its worker rotation kernel.
  "src/infra/device-pairing-cloud-worker.ts", // Bootstrap worker dispatcher owns binding checks and completion writes.
  "src/infra/promotions-feed.kernel.ts", // Promotion claims execute through promotions-feed.worker.
  "src/infra/push-apns-store-transaction.ts", // APNs worker cleanup and pairing worker clearApnsNodeIds only.
  "src/infra/push-apns-store.ts", // SQL read kernels are called only by the APNs worker dispatcher.
  "src/infra/session-cost-usage-worker.ts",
  "src/infra/telemetry-store.kernel.ts", // Telemetry SQL executes through the shared-state worker runtime.
  "src/infra/update-candidate-exec-approvals.ts", // Approval projections run in the update-candidate-state worker.
  "src/infra/update-candidate-plugins.ts", // Plugin inventory and copying run in the update-candidate-state worker.
  "src/infra/update-run-interruption-store.ts", // Interruption writes use the shared-state worker; host imports are pure.
  "src/infra/update-run-reconciliation.read.ts", // Reconciliation reads use state-read and reconciliation workers.

  "src/infra/outbound/delivery-queue-media-staging.kernel.ts", // Media retention SQL executes through delivery-queue.worker.
  "src/infra/outbound/delivery-queue-storage.kernel.ts", // Outbound reads use state-read; mutations use delivery storage workers.

  "src/node-host/node-worker-launch-store.kernel.ts", // node-worker-journal.worker.ts and the spawned service-child-group anchor own launch SQL.
  "src/node-host/node-worker-turn-store.kernel.ts", // Turn kernels are instantiated only by node-worker-journal.worker.

  "src/plugin-state/plugin-blob-store.sqlite.ts", // Plugin-blob writes and shared-state read worker only.

  "src/plugins/conversation-binding-state.kernel.ts", // Shared-state worker binding-approval commands only.
  "src/plugins/official-external-plugin-catalog-snapshot-store.kernel.ts", // Shared-state worker catalog-snapshot commands only.

  "src/projects/project-registry.kernel.ts", // Project registry handler table is the only runtime caller of its SQL kernels.

  "src/secrets/store/secret-store-config-ref.kernel.ts", // Config-ref writes are called only by the shared-state worker runtime.
  "src/secrets/store/secret-store-expiry.kernel.ts", // Expiry SQL uses shared-state worker dispatch; host captures cutoffs only.
  "src/secrets/store/secret-store-metadata.kernel.ts", // Metadata, exec environment, and exact values only run through stateReadRegistry in the shared-state reader.

  "src/skills/lifecycle/upload-store-commit.ts", // Skill-upload worker commit command only.
  "src/skills/lifecycle/upload-store.kernel.ts", // Skill-upload worker dispatcher only.
  "src/skills/lifecycle/upload-store.sqlite.ts", // Skill-upload worker kernels; host imports pure options only.

  "src/skills/workshop/collection-review.kernel.ts", // Skill-workshop worker collection-review reads only.
  "src/skills/workshop/curator.kernel.ts", // Skill-workshop worker curator and usage commands only.
  "src/skills/workshop/store-proposal.kernel.ts", // Skill-workshop worker proposal commands only.
  "src/skills/workshop/store-sqlite-event.ts", // Skill-workshop and shared-state Doctor worker commands only.
  "src/skills/workshop/store-sqlite-rollback.ts", // Skill-workshop worker rollback commands only.
  "src/skills/workshop/store-sqlite-transition.ts", // Skill-workshop worker transition commands only.

  "src/state/backup-run-records.kernel.ts", // Backup record writes are called only by the shared-state worker runtime.
  "src/state/github-personal-publication-lifecycle.ts", // Receipt SQL runs in shared-state worker dispatch; host helper enqueues commands.
  "src/state/openclaw-state-lease-worker.ts", // Lease transaction dispatch is called only by the shared-state worker backend.
  "src/state/openclaw-state-worker-runtime.ts",
  "src/state/session-repository-workspaces.kernel.ts", // SQL callers are shared-state workspace dispatch and the state read worker.

  "src/transcripts/store-sqlite-read.ts", // SQL callers are transcript worker read/write dispatchers only.
  "src/transcripts/store-sqlite-write.ts", // SQL writes are called only by the transcript worker dispatcher.
  "src/transcripts/store-sqlite.ts", // SQL callers are transcript worker kernels; host imports are pure helpers.
  "src/transcripts/store-worker-write.ts", // Called only by the shared-state worker runtime.
]);
const exceptionModules = new Set([
  "src/state/openclaw-state-db-transaction.ts",
  "src/state/openclaw-state-lease-store.ts",
  "src/state/openclaw-state-lease-storage.ts",
  "src/state/openclaw-agent-db-lease.ts",
  "src/infra/gateway-boot-lifecycle.ts",
]);
const cliModules = new Map([
  [
    "src/claws/provenance-adopted.ts",
    "Only claws migrate/remove CLI one-shots call these writers via migrate.ts and lifecycle-adopted-removal.ts; no Gateway caller",
  ],
  [
    "src/infra/package-update-activation-immutable.ts",
    "Adoption/preparation writers are called only by update-command-immutable.ts through update-immutable-install.ts; Gateway inspection dispatches immutableInstall.read through the SQLite read-only worker",
  ],
]);

function classify(file, operation, binding) {
  const reviewedOperation = reviewedOperations
    .get(file)
    ?.find(
      (entry) =>
        entry.operations.includes(operation) &&
        (entry.binding === undefined || entry.binding === binding),
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

function findCalls(source) {
  const names = new Map([...primitives.keys()].map((name) => [name, name]));
  for (const statement of source.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (primitives.has(imported)) {
          names.set(element.name.text, imported);
        }
      }
    }
  }
  const calls = [];
  function visit(node, parentOperation, parentBinding) {
    let operation = parentOperation;
    let binding = parentBinding;
    // Initializer exceptions stop at callbacks; their SQL needs its own caller proof.
    if (ts.isFunctionLikeDeclaration(node)) {
      binding = undefined;
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
        calls.push({
          primitive,
          line: line + 1,
          column: character + 1,
          operation,
          ...(binding === undefined ? {} : { binding }),
        });
      }
    }
    node.forEachChild((child) => visit(child, operation, binding));
  }
  visit(source, "");
  return calls;
}

export function inventory(root = defaultRoot, ref = "", staged = false) {
  using parser = createNativeTypeScriptParser({ cwd: root });
  const roots = ["src", "extensions", "packages", "scripts"];
  const pattern = [...primitives.keys()].join("|");
  const snapshot = ref !== "" || staged;
  const result = spawnSync(
    snapshot ? "git" : "rg",
    snapshot
      ? [
          "grep",
          "-l",
          "-z",
          "-E",
          ...(ref ? [] : ["--cached"]),
          pattern,
          ...(ref ? [ref] : []),
          "--",
          ...roots,
        ]
      : [
          "-l",
          "--null",
          "-g",
          "*.{ts,tsx,js,mjs,mts,cts,cjs}",
          pattern,
          ...roots.filter((dir) => fs.existsSync(path.join(root, dir))),
        ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw result.error ?? new Error(result.stderr || "SQLite inventory source scan failed");
  }
  const files = result.stdout
    .split("\0")
    .map((file) => (ref ? file.slice(ref.length + 1) : file))
    .filter((file) => /\.(?:ts|tsx|js|mjs|mts|cts|cjs)$/.test(file) && !excluded.test(file));
  const texts = snapshot ? loadRatchetSources(root, files, ref) : null;
  const sources = parser.parseSourceFiles(
    files.map((fileName) => ({
      fileName,
      text: texts ? texts.get(fileName) : fs.readFileSync(path.join(root, fileName), "utf8"),
    })),
  );
  const invalidSource = parser.getSyntacticDiagnostics()[0];
  if (invalidSource) {
    throw new Error(
      `Cannot inventory invalid syntax in ${path.relative(root, invalidSource.fileName ?? root)}`,
    );
  }
  return files
    .flatMap((file, index) => {
      const calls = findCalls(sources[index]);
      const groups = new Map();
      for (const call of calls) {
        const classification = classify(file, call.operation, call.binding);
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
      return [...groups.values()].map((group) => {
        group.evidence = [...group.evidence].join("; ");
        return group;
      });
    })
    .toSorted(
      (a, b) =>
        a.tier.localeCompare(b.tier, "en") ||
        a.priority - b.priority ||
        a.owner.localeCompare(b.owner, "en") ||
        a.file.localeCompare(b.file, "en"),
    );
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
    "Regenerate with `pnpm db:worker-inventory:gen`; verify with `pnpm db:worker-inventory:check`. `node scripts/database-worker-inventory.mjs --json` emits every call's primitive, line, column, lexical operation path, optional variable-initializer binding, file owner, tier, and classification evidence. The script uses the repository's TypeScript parser and `rg`; it does not load application code or open a database.",
    "",
    "## Scope and interpretation",
    "",
    "T1 is request/event/timer exposure, including conservatively retained runtime or mixed kernels whose callers still need tracing. T2 is startup, migration, or a named boot/lock exception candidate. T3 is CLI, Doctor, or developer one-shot code. W marks worker implementations separately: their synchronous SQL is intentional and is not outstanding main-thread debt. A filename-based T2/T3/W classification is an audit lead, not a proof that every caller is safe. Do not move a mixed kernel or a module with ‘worker’ in its name to W without tracing its callers.",
    "",
    "Reviewed mixed modules classify calls by their named lexical operation path, optionally narrowed to a variable initializer. Initializer exceptions exclude nested function bodies, so unrelated sites remain conservative even when source lines move. Other file tiers retain the broadest applicable counted exposure, including explicit worker/maintenance mixtures. Each file has at most one row per tier; tier file counts overlap, while total files and call expressions are unique. These are not measured runtime call counts. Recheck the operation and all registered callers before changing its classification. Maintenance invoked by Gateway timers remains T1. Prepared results never confer current authority; follow [worker access](/reference/database-schemas/worker-access).",
    "",
    "Canonical-repair mutations remain T2 Doctor work, but its exact-row reader remains T1 because Gateway agent creation invokes legacy-main detection. Incognito category reads and native approval SDK compatibility remain T1. Claw provenance's counted writes are CLI-only; its raw Gateway reads are still runtime debt outside the five-primitive scan. Likewise, worker-only direct Cron receipt calls do not classify the host current-authority reads they transitively expose. Reclassification corrects metadata; it does not move runtime SQL or demonstrate a speedup.",
    "",
    "The scan covers JavaScript/TypeScript files under `src/`, `extensions/`, `packages/`, and `scripts/` as selected by `rg` (respecting ignore rules). It recognizes direct calls, property calls with these names, and named-import aliases. It does not resolve higher-order aliases, dynamic dispatch, transitive wrappers, direct `DatabaseSync` methods, other query primitives, or native-language SQLite. It is a reproducible migration queue, not a complete prohibition checker. Tests are deliberately excluded rather than counted as T3.",
    "",
    "| Key | Primitive |",
    "| --- | --- |",
    ...[...primitives].map(([name, key]) => `| ${key} | \`${name}\` |`),
    "",
    "| Tier | Files | Call expressions |",
    "| --- | ---: | ---: |",
    ...["T1", "T2", "T3", "W"].map((tier) => {
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
    "| 1 | `ensureProfileForEmail`; `updateExecApprovals` | Separate write-coordination lane; exclude from this cutover. The 47% is shared, not a measurement of either method alone. |",
    "| 2 | `sessions.list` → `listProjectedSessions` → resident session row projection | Warm requests already reuse resident rows with no host Kysely reads. Hydration, dirty/archived rows, and membership reads remain migration debt; preserve identity-keyed reuse and projection revisions. |",
    "| 3 | `chat.history` → history worker | Ordinary durable pages already use the worker. This cutover moves raw cursor delta reads and JSON parsing through the same owner; display/profile projection, byte budgets, and fresh sharing checks stay on the host. |",
    "| 4 | Transcript search → `session-transcript-search.ts` | The async facade moves durable FTS reads through the existing worker lifecycle for the runtime callers: `sessions-read.ts`, `sessions-search-projected.ts`, and `embedded-gateway-stub.ts`. Callers recheck current scope and authorization after awaiting. |",
    "| 5 | Task/flow registry | Async read facades already use workers; native mutations and mixed kernels remain. Preserve accepted-write fences and projection publication. |",
    "| 6 | Provider catalog → `plugin-model-catalog.ts` | Persisted reads reached from `models-config.ts` and prepared model runtime; keep Doctor imports distinct. |",
    "",
    "The warm `sessions.list` baseline used 5,000 rows, 50 viewers, and 350 calls: **zero host Kysely reads**, **3.07538 ms CPU per call**, and **3.12680 ms amortized wall time per call**. The original per-request store scan was already gone, so this lane does not claim another warm-list database cutover or speedup. These numbers do not cover projection hydration, dirty-row refresh, archived-row materialization, or membership reads.",
    "",
    "The history cutover leaves selected/current session entries, pending-input/receipt reads, the retained transcript-session key, and lazy subagent source/run-input visibility reads as native work. Ordinary full pages and raw cursor deltas use the history worker. Bound Claude CLI history now uses its temporary merge index: cold preparation scans bounded source windows, and page/anchor requests project only selected messages. Process-held incognito database custody remains migration work because its database cannot be reopened by a durable path in another isolate. Its CLI-history adapter supplies bounded pages from the existing native owner to a request-scoped, memory-only worker index; ownership checks consume committed in-memory facts without additional native revision queries. A failed durable worker read never selects that local path.",
    "",
    "Durable session reaction summaries and target-message reads use the admitted history worker; reaction writes use the canonical SQLite worker broker with live transaction and commit admission. Process-held incognito reads and writes retain their sole native owner because their database cannot be reopened by path. The synchronous reaction kernel is shared by those admitted worker and incognito paths; no new broker capability or native fallback is added. Reaction mirroring reads durable source conversation bindings through the history worker, including a final read after account/config preparation and immediately before dispatch; synchronous handoff guards retain live reactor, session, and config checks. The conversation registry remains T1 because other synchronous callers are outside this cutover. Schemas, stored bytes, retention, and update behavior are unchanged.",
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
    "| Session membership | `session-row-projection-materialize.ts` calls `listSessionMembers`; prepare membership with row facts and invalidate from the existing sharing/projection revision. |",
    "",
    "## Call sites by tier and owner",
    "",
    "Counts use `Q/F/S/A/R` in that order. Source locations are available in `--json`; the first call line below is a navigation hint. Owner labels are source directory boundaries, not CODEOWNERS assignments. Generic runtime candidates require caller evidence before claiming a main-thread defect or a completed migration.",
  ];
  for (const tier of ["T1", "T2", "T3", "W"]) {
    lines.push(
      "",
      `### ${tier}`,
      "",
      "| Owner / file | Calls (Q/F/S/A/R) | First line | Exposure evidence |",
      "| --- | ---: | ---: | --- |",
    );
    for (const row of rows.filter((entry) => entry.tier === tier)) {
      const counts = [...primitives.keys()]
        .map((primitive) => row.calls.filter((call) => call.primitive === primitive).length)
        .join("/");
      lines.push(
        `| **${row.owner}** · \`${row.file}\` | ${counts} | ${row.calls[0].line} | ${row.evidence} |`,
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
      console.log(JSON.stringify({ totals: totals(rows), files: rows }, null, 2));
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
