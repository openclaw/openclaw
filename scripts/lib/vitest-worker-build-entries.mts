import { codexCatalogPageWorkerEntrypoint } from "../../extensions/codex/catalog-page-worker-entrypoint.ts";
import { discordAudioTestEntrypoints } from "../../extensions/discord/src/voice/audio-worker-entrypoints.test-support.ts";
import { logbookSqliteBackendEntrypoint } from "../../extensions/logbook/src/sqlite-backend-entrypoint.test-support.ts";
import { memoryPublicationFaultEntrypoint } from "../../extensions/memory-core/src/memory/manager-publication-fault-entrypoint.test-support.ts";
import { qaGatewayCleanupRuntimeEntrypoint } from "../../extensions/qa-lab/src/gateway-child-artifacts-runtime.test-support.ts";
import { teamReportsSqliteBackendEntrypoint } from "../../extensions/team-reports/src/sqlite-backend-entrypoint.test-support.ts";
import { workboardSqliteBackendEntrypoint } from "../../extensions/workboard/src/sqlite-backend-entrypoint.test-support.ts";
import { authProfileScopeCwdEntrypoint } from "../../src/agents/auth-profiles/store-scope-cwd-runtime.test-support.ts";
import {
  codeModeDescriptionRetentionEntrypoint,
  codeModeRetentionEntrypoint,
} from "../../src/agents/code-mode-retention-entrypoint.test-support.ts";
import { cliCompactionBackendEntrypoints } from "../../src/agents/command/cli-compaction-runtime.test-support.ts";
import { bashOutputSpillEntrypoints } from "../../src/agents/sessions/bash-output-spill-entrypoints.test-support.ts";
import {
  cliRecoveryEntrypoints,
  gatewayDirectStopEntrypoints,
  updateExecutorEntrypoints,
  stateDirGatewayFixtureEntrypoint,
  updateCandidateExitEntrypoints,
} from "../../src/cli/cli-entrypoint.test-support.ts";
import { updateExecutorNativeEntrypoints } from "../../src/cli/update-cli/update-command-executor-native-runtime.test-support.ts";
import { doctorConfigRuntimeEntrypoints } from "../../src/commands/doctor-config-runtime.test-support.ts";
import { cronOwnerHardeningEntrypoints } from "../../src/cron/owner-hardening-runtime.test-support.ts";
import { sessionChildCacheRetentionEntrypoint } from "../../src/gateway/session-child-cache-retention-entrypoint.test-support.ts";
import { sessionTitleRetentionEntrypoints } from "../../src/gateway/session-title-retention.test-support.ts";
import {
  triageTestRuntimeEntrypoints,
  triageMaintenanceRuntimeEntrypoints,
} from "../../src/infra/triage-runtime.test-support.ts";
import { nodeHostConfigRuntimeEntrypoint } from "../../src/node-host/config-runtime.test-support.ts";
import {
  mcpProviderCatalogEntrypoint,
  publishedSdkBridgeEntrypoints,
} from "../../src/plugins/loader-sdk-bridge-artifacts.test-support.ts";
import { pluginRuntimeRetentionEntrypoint } from "../../src/plugins/runtime-retention-entrypoint.test-support.ts";
import { persistenceRuntimeEntrypoint } from "../../src/skills/library/persistence-runtime.test-support.ts";
import { gitBackupCommandRuntimeEntrypoint } from "../../src/snapshot/git-backup-command-runtime.test-support.ts";
import { agentDatabaseModuleIdentityEntrypoints } from "../../src/state/openclaw-agent-db-module-identity-runtime.test-support.ts";
import { agentWorkerStoreFixtureEntrypoint } from "../../src/state/openclaw-agent-worker-store.runtime.test-support.ts";
import { databaseVerifyHostRuntimeEntrypoint } from "../../src/state/openclaw-database-verify-runtime.test-support.ts";
import {
  agentDatabaseHeldRuntimeEntrypoint,
  stateLeaseProcessExitRuntimeEntrypoint,
  stateLeaseRetentionRuntimeEntrypoint,
} from "../../src/state/openclaw-state-lease-runtime.test-support.ts";
import { groqSetupSdkEntrypoints } from "../../src/system-agent/setup-inference-groq-sdk.test-support.ts";
import { tuiPtyRuntimeEntrypoints } from "../../src/tui/tui-pty-runtime-test-support.ts";
import { workerBackgroundExecEntrypoints } from "../../src/worker/worker-runtime-background-exec-entrypoints.test-support.ts";
import { channelIngressGatewayRestartEntrypoint } from "../../test/fixtures/channel-ingress-gateway-restart-entrypoint.ts";
import { runtimeProcessBuildEntrypoints } from "./runtime-process-build-entries.mts";
import { createRuntimeProcessBuildEntries } from "./runtime-process-core-build-entries.mts";
import { nativeSchtasksIntegrationEnabled } from "./vitest-worker-declarations.mts";

// These fixture hooks require physical module boundaries and complete namespaces.
export const legacyFinalizerBuildSources = [
  "src/cli/update-finalization-output.test-support.ts",
  "src/cli/program/register.maintenance.ts",
  "src/cli/one-shot-exit.ts",
  "src/commands/doctor.ts",
  "src/commands/doctor-lint.ts",
  "src/commands/doctor-post-upgrade.ts",
  "src/config/config.ts",
  "src/config/paths.ts",
  "src/plugins/installed-plugin-index-records.ts",
  "src/plugins/plugin-lifecycle-lease.ts",
  "src/cli/update-cli/update-command-config-snapshot.ts",
  "src/cli/update-cli/update-command-config.ts",
  "src/cli/update-cli/update-command-plugins.ts",
  "src/cli/update-cli/update-finalization-lifecycle.ts",
  "src/cli/update-cli/update-command-report.ts",
  "src/commands/doctor-service-repair-policy.ts",
  "src/cli/update-cli/update-command-service-maintenance.ts",
  "src/daemon/service.ts",
  "src/cli/daemon-cli/restart-health.ts",
  "src/commands/doctor/shared/legacy-config-binding-repair.runtime.ts",
  "src/cli/update-cli/update-command-legacy-finalize.test-support.ts",
  "src/infra/update-migrated-finalize.worker.ts",
  "src/infra/runtime-process-entrypoints.ts",
  "src/cli/update-cli/update-command-service-plan.ts",
  "src/infra/tmp-openclaw-dir.ts",
  "src/cli/update-cli/update-command-convergence.ts",
  "src/cli/update-cli/update-command-restart-context.ts",
  "src/daemon/gateway-entrypoint.ts",
  "src/cli/update-cli/update-command-verification.ts",
  "src/cli/update-cli/shared.ts",
  "src/cli/update-cli/update-command-service-command.ts",
];

// Test-only roots share the invocation generation without changing package entries.
export const vitestWorkerBuildEntries = {
  "legacy-config-binding-repair.runtime":
    "src/commands/doctor/shared/legacy-config-binding-repair.runtime.ts",
  ...createRuntimeProcessBuildEntries([
    ...runtimeProcessBuildEntrypoints,
    ...Object.values(discordAudioTestEntrypoints),
    codexCatalogPageWorkerEntrypoint,
    agentWorkerStoreFixtureEntrypoint,
    memoryPublicationFaultEntrypoint,
    ...Object.values(triageTestRuntimeEntrypoints),
    ...Object.values(triageMaintenanceRuntimeEntrypoints),
    authProfileScopeCwdEntrypoint,
    codeModeRetentionEntrypoint,
    codeModeDescriptionRetentionEntrypoint,
    ...cliCompactionBackendEntrypoints,
    ...Object.values(bashOutputSpillEntrypoints),
    ...publishedSdkBridgeEntrypoints,
    mcpProviderCatalogEntrypoint,
    pluginRuntimeRetentionEntrypoint,
    ...groqSetupSdkEntrypoints,
    ...Object.values(cliRecoveryEntrypoints),
    ...Object.values(updateCandidateExitEntrypoints),
    ...Object.values(updateExecutorNativeEntrypoints),
    ...Object.values(updateExecutorEntrypoints),
    ...Object.values(gatewayDirectStopEntrypoints),
    stateDirGatewayFixtureEntrypoint,
    ...Object.values(doctorConfigRuntimeEntrypoints),
    ...Object.values(cronOwnerHardeningEntrypoints),
    ...(nativeSchtasksIntegrationEnabled
      ? Object.values(
          (await import("../../src/daemon/schtasks-native-entrypoints.test-support.ts"))
            .schtasksNativeEntrypoints,
        )
      : []),
    ...Object.values(tuiPtyRuntimeEntrypoints),
    ...Object.values(sessionTitleRetentionEntrypoints),
    sessionChildCacheRetentionEntrypoint,
    nodeHostConfigRuntimeEntrypoint,
    ...Object.values(workerBackgroundExecEntrypoints),
    channelIngressGatewayRestartEntrypoint,
    persistenceRuntimeEntrypoint,
    gitBackupCommandRuntimeEntrypoint,
    qaGatewayCleanupRuntimeEntrypoint,
    logbookSqliteBackendEntrypoint,
    teamReportsSqliteBackendEntrypoint,
    workboardSqliteBackendEntrypoint,
    ...Object.values(agentDatabaseModuleIdentityEntrypoints),
    stateLeaseProcessExitRuntimeEntrypoint,
    stateLeaseRetentionRuntimeEntrypoint,
    agentDatabaseHeldRuntimeEntrypoint,
    databaseVerifyHostRuntimeEntrypoint,
  ]),
  // The real ulimit fixture must import its parent before imposing a file-size limit.
  "infra/sqlite-snapshot-source": "src/infra/sqlite-snapshot-source.ts",
  // Keep provider preparation in the same compiled graph as payload rendering;
  // a source-injected plugin would miss duplicated registry scope state.
  "plugins/provider-hook-runtime": "src/plugins/provider-hook-runtime.ts",
  // Real provider preparation uses packaged JavaScript, avoiding per-child source transforms.
  "extensions/anthropic/index": "extensions/anthropic/index.ts",
  // Candidate finalization runs the real mandatory post-plugin readiness surface.
  "extensions/memory-core/doctor-health-api": "extensions/memory-core/doctor-health-api.ts",
  "test-support/anthropic-preparation": "test/scripts/anthropic-preparation-probe.ts",
  // Exercise native writes through the existing plugin facade in the private graph.
  "plugin-sdk/file-access-runtime": "src/plugin-sdk/file-access-runtime.ts",
};
