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
          "createPlacementSessionToolOperationKernel.hasToolAuthority",
          "createPlacementSessionToolOperationKernel.settleWorkerSessionToolOperation",
          "createPlacementSessionToolOperationKernel.authorize",
          "createPlacementSessionToolOperationKernel.clear",
          "createPlacementSessionToolOperationKernel.begin",
          "createPlacementSessionToolOperationKernel.bindChild",
          "createPlacementSessionToolOperationKernel.recover",
        ],
        evidence:
          "Factory only constructed by placement-session-tool-operations.worker.ts:27; shared native transaction helpers stay T1",
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
          "state-read.worker.ts:648,659 and placement-workspace-journal.worker.ts:30; host acceptance/drain cleanup stays T1",
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
        ],
        evidence:
          "Factory only in store.kernel.ts:99 -> store.worker.ts:48; native consume and shared reader stay T1",
      },
    ],
  ],
  [
    "src/gateway/worker-environments/placement-row-codec.ts",
    [
      {
        tier: "W",
        operations: ["readWorkerPlacementChangeSnapshotInDatabase"],
        evidence: "Reporting snapshot only called by openclaw-state-read.worker.ts:644",
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
    "src/gateway/operator-approval-store.transitions.ts",
    [
      {
        tier: "T2",
        operations: ["closeOrphanedOperatorApprovals", "pruneTerminalOperatorApprovals"],
        evidence:
          "Boot calls only in server-aux-handlers.ts:105,109; remaining transitions retain native SDK compatibility",
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
        evidence:
          "session-state-events.worker.ts:146,147 and session-upstream-links.worker.ts:18,25; shared event/prune and child-spawn seed sites stay T1",
      },
      {
        tier: "W",
        operations: ["readCursor", "readMaterialCursors", "updateMaterialCursor"],
        evidence:
          "Watch calls only in session-state-events.worker.ts:40,58,95; event cursor paths gated by NOTIFY_BY_KIND at kernel:367,386; native producers are non-notifying",
      },
      {
        tier: "W",
        operations: ["recordSessionStateEventInDatabase"],
        binding: "registeredWatcherKeys",
        evidence:
          "Only the registeredWatcherKeys initializer at kernel:354 is notifying-only; worker record at session-state-events.worker.ts:158 / subagent-registry.store.worker.ts:65; other event sites remain T1",
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
          "Admission/recovery/reservation/state/maintenance/dispatch workers own direct primitives; host guard at :557 still reaches run-receipt-read.ts:133 and row-codec.ts:262",
      },
    ],
  ],
  [
    "src/cron/store/run-receipt-read.ts",
    [
      {
        tier: "W",
        operations: ["readActiveCronRunReceiptOwnersInDatabase"],
        evidence:
          "read-command.ts:72 -> openclaw-state-read.worker.ts:353; current-authority read stays T1",
      },
    ],
  ],
  [
    "src/cron/store/row-codec.ts",
    [
      {
        tier: "T3",
        operations: [
          "readCronJobsFingerprint",
          "replaceCronRows",
          "upsertCronJobRow",
          "deleteCronJobRowInDatabase",
          "revokeCronJobStandingGrants",
        ],
        evidence:
          "Cron workers or Doctor legacy-repair.ts:380,395 / store-repair.ts:175,183 / doctor-heartbeat-task-migration.ts:348; current-authority and standing-generation reads stay T1",
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
        tier: "W",
        operations: ["replaceWorkspaceAttestationInDatabase"],
        evidence:
          "workspace.replaceAttestation dispatch in openclaw-state-worker-runtime.ts:205; shared snapshot/alias helpers stay T1",
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
]);
const workerModules = new Set([
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
  "src/secrets/store/secret-store-metadata.kernel.ts", // Metadata listing only runs through stateReadRegistry in the shared-state reader.

  "src/sessions/session-upstream-links.kernel.ts", // openclaw-state.worker.ts dispatches sessionUpstream.listWatched; host imports only the codec.

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
    "The history cutover leaves selected/current session entries, pending-input/receipt reads, the retained transcript-session key, and lazy subagent source/run-input visibility reads as native work. Ordinary full pages were already worker-backed; raw cursor delta reads now share that worker. Process-held incognito database lifetime and the existing CLI-import history path remain explicit migration gaps. Incognito data cannot be reopened by a durable path in another isolate; this is remaining owner/lifetime work, not a new synchronous exception. A failed durable worker read never selects that local path.",
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
