import { quickJsWorkerTestEntrypoint } from "../../extensions/code-mode-quickjs/src/worker-entrypoint.test-support.ts";
import { codexCatalogPageWorkerEntrypoint } from "../../extensions/codex/catalog-page-worker-entrypoint.ts";
import { discordAudioTestEntrypoints } from "../../extensions/discord/src/voice/audio-worker-entrypoints.test-support.ts";
import { logbookSqliteBackendEntrypoint } from "../../extensions/logbook/src/sqlite-backend-entrypoint.test-support.ts";
import { memoryPublicationFaultEntrypoint } from "../../extensions/memory-core/src/memory/manager-publication-fault-entrypoint.test-support.ts";
import { vectorKnnParentEntrypoint } from "../../extensions/memory-core/src/memory/manager-search-knn-runtime.test-support.ts";
import { realtimeAudioTestEntrypoints } from "../../extensions/openai/realtime-audio-worker-entrypoints.test-support.ts";
import { busServerShutdownEntrypoint } from "../../extensions/qa-lab/src/bus-server-runtime.test-support.ts";
import { qaGatewayCleanupRuntimeEntrypoint } from "../../extensions/qa-lab/src/gateway-child-artifacts-runtime.test-support.ts";
import { teamReportsSqliteBackendEntrypoint } from "../../extensions/team-reports/src/sqlite-backend-entrypoint.test-support.ts";
import { workboardSqliteBackendEntrypoint } from "../../extensions/workboard/src/sqlite-backend-entrypoint.test-support.ts";
import { agentCoreRetentionEntrypoints } from "../../packages/agent-core/src/retention-runtime.test-support.ts";
import { cleanForGeminiEntrypoint } from "../../packages/ai/src/providers/clean-for-gemini-runtime.test-support.ts";
import { eventStreamRetentionEntrypoint } from "../../packages/llm-core/src/retention-runtime.test-support.ts";
import { eventHubRetentionEntrypoint } from "../../packages/sdk/src/retention-runtime.test-support.ts";
import { tableStackEntrypoint } from "../../packages/terminal-core/src/table-runtime.test-support.ts";
import { authProfileScopeCwdEntrypoint } from "../../src/agents/auth-profiles/store-scope-cwd-runtime.test-support.ts";
import { processPollLivenessEntrypoint } from "../../src/agents/bash-tools.process-liveness-runtime.test-support.ts";
import {
  codeModeDescriptionRetentionEntrypoint,
  codeModeRetentionEntrypoint,
} from "../../src/agents/code-mode-retention-entrypoint.test-support.ts";
import { cliCompactionBackendEntrypoints } from "../../src/agents/command/cli-compaction-runtime.test-support.ts";
import { agentProcessTestEntrypoints } from "../../src/agents/process-runtime.test-support.ts";
import { bashOutputSpillEntrypoints } from "../../src/agents/sessions/bash-output-spill-entrypoints.test-support.ts";
import { managedWorktreeGcEntrypoint } from "../../src/agents/worktrees/service-gc-runtime.test-support.ts";
import { clawProjectBuildEntrypoint } from "../../src/claws/project-runtime.test-support.ts";
import {
  cliRecoveryEntrypoints,
  gatewayDirectStopEntrypoints,
  updateExecutorEntrypoints,
  stateDirGatewayFixtureEntrypoint,
  updateCandidateExitEntrypoints,
} from "../../src/cli/cli-entrypoint.test-support.ts";
import { updateExecutorNativeEntrypoints } from "../../src/cli/update-cli/update-command-executor-native-runtime.test-support.ts";
import { doctorConfigRuntimeEntrypoints } from "../../src/commands/doctor-config-runtime.test-support.ts";
import { sessionNativeProcessEntrypoints } from "../../src/config/sessions/native-process-runtime.test-support.ts";
import { cronOwnerHardeningEntrypoints } from "../../src/cron/owner-hardening-runtime.test-support.ts";
import { serviceProcessEnvEntrypoints } from "../../src/daemon/service-process-env-runtime.test-support.ts";
import { sessionChildCacheRetentionEntrypoint } from "../../src/gateway/session-child-cache-retention-entrypoint.test-support.ts";
import { sessionTitleRetentionEntrypoints } from "../../src/gateway/session-title-retention.test-support.ts";
import { workspaceProcessTestEntrypoints } from "../../src/gateway/worker-environments/workspace-process-runtime.test-support.ts";
import { nativeBoundaryTestEntrypoints } from "../../src/infra/native-boundary-runtime.test-support.ts";
import { nativeProcessTestEntrypoints } from "../../src/infra/native-process-runtime.test-support.ts";
import { externalProxyTestEntrypoints } from "../../src/infra/net/proxy/external-proxy-runtime.test-support.ts";
import { deliveryQueueProcessEntrypoints } from "../../src/infra/outbound/delivery-queue-process-runtime.test-support.ts";
import { sqliteMaintenanceEntrypoints } from "../../src/infra/sqlite-maintenance-runtime.test-support.ts";
import { sqliteReadOnlyCompileCacheParentEntrypoint } from "../../src/infra/sqlite-readonly-worker.compile-cache-runtime.test-support.ts";
import { sqliteSnapshotStagingEntrypoints } from "../../src/infra/sqlite-snapshot-staging-runtime.test-support.ts";
import { sqliteWorkerStoreCompileCacheParentEntrypoint } from "../../src/infra/sqlite-worker-store.compile-cache-runtime.test-support.ts";
import { storageProcessTestEntrypoints } from "../../src/infra/storage-process-runtime.test-support.ts";
import {
  triageTestRuntimeEntrypoints,
  triageMaintenanceRuntimeEntrypoints,
} from "../../src/infra/triage-runtime.test-support.ts";
import { workerTaskPoolEntrypoints } from "../../src/infra/worker-task-pool-runtime.test-support.ts";
import { diagnosticProfileEntrypoints } from "../../src/logging/diagnostic-profile-runtime.test-support.ts";
import { mediaNativeProcessEntrypoints } from "../../src/media/native-process-runtime.test-support.ts";
import { nodeHostConfigRuntimeEntrypoint } from "../../src/node-host/config-runtime.test-support.ts";
import {
  mcpProviderCatalogEntrypoint,
  mcpPluginToolsServeEntrypoint,
  publishedSdkBridgeEntrypoints,
} from "../../src/plugins/loader-sdk-bridge-artifacts.test-support.ts";
import { pluginProcessRuntimeEntrypoints } from "../../src/plugins/process-runtime.test-support.ts";
import { pluginRetentionEntrypoints } from "../../src/plugins/retention-runtime.test-support.ts";
import { pluginRuntimeRetentionEntrypoint } from "../../src/plugins/runtime-retention-entrypoint.test-support.ts";
import { processProbeEntrypoints } from "../../src/process/process-probes-runtime.test-support.ts";
import { execOutputRetentionEntrypoint } from "../../src/process/retention-runtime.test-support.ts";
import { proxyCaptureNativeProcessEntrypoints } from "../../src/proxy-capture/native-process-runtime.test-support.ts";
import { workerBundleArchiveEntrypoint } from "../../src/shared/worker-bundle-archive-runtime.test-support.ts";
import { persistenceRuntimeEntrypoint } from "../../src/skills/library/persistence-runtime.test-support.ts";
import { gitBackupCommandRuntimeEntrypoint } from "../../src/snapshot/git-backup-command-runtime.test-support.ts";
import { stateNativeProcessEntrypoints } from "../../src/state/native-process-runtime.test-support.ts";
import { agentDatabaseModuleIdentityEntrypoints } from "../../src/state/openclaw-agent-db-module-identity-runtime.test-support.ts";
import { agentWorkerStoreFixtureEntrypoint } from "../../src/state/openclaw-agent-worker-store.runtime.test-support.ts";
import { databaseVerifyHostRuntimeEntrypoint } from "../../src/state/openclaw-database-verify-runtime.test-support.ts";
import {
  agentDatabaseHeldRuntimeEntrypoint,
  stateLeaseProcessExitRuntimeEntrypoint,
  stateLeaseRetentionRuntimeEntrypoint,
} from "../../src/state/openclaw-state-lease-runtime.test-support.ts";
import { groqSetupSdkEntrypoints } from "../../src/system-agent/setup-inference-groq-sdk.test-support.ts";
import { tempDirEntrypoint } from "../../src/test-helpers/temp-dir-runtime.test-support.ts";
import { transcriptLibraryTimezoneEntrypoint } from "../../src/transcripts/library-timezone-runtime.test-support.ts";
import { tuiPtyRuntimeEntrypoints } from "../../src/tui/tui-pty-runtime-test-support.ts";
import { clackPrompterProcessEntrypoint } from "../../src/wizard/clack-prompter-process-runtime.test-support.ts";
import { workerBackgroundExecEntrypoints } from "../../src/worker/worker-runtime-background-exec-entrypoints.test-support.ts";
import { qaOtelSmokeEntrypoint } from "../../test/e2e/qa-lab/runtime/qa-otel-smoke-entrypoint.test-support.ts";
import { channelIngressGatewayRestartEntrypoint } from "../../test/fixtures/channel-ingress-gateway-restart-entrypoint.ts";
import { toolingNativeRuntimeEntrypoints } from "../../test/scripts/tooling-native-runtime.test-support.ts";
import { toolingProbeRuntimeEntrypoints } from "../../test/scripts/tooling-probe-runtime.test-support.mts";
import { benchSessionHistoryEntrypoint } from "../bench-session-history-runtime.test-support.ts";
import { runtimeProcessBuildEntrypoints } from "./runtime-process-build-entries.mts";
import { createRuntimeProcessBuildEntries } from "./runtime-process-core-build-entries.mts";
import { nativeSchtasksIntegrationEnabled } from "./vitest-worker-declarations.mts";

// These fixture hooks require physical module boundaries and complete namespaces.
export const preservedModuleBuildSources = [
  "extensions/acpx/src/runtime.admission-retention.test-support.ts",
  "scripts/lib/tsdown-declaration-boundary.mts",
  "scripts/lib/sqlite-reliability-writer.ts",
  "scripts/plugin-release-pretag-pack-check.ts",
  "scripts/lib/cross-os-release-checks/process.ts",
  "scripts/check-plugin-gateway-gauntlet.mts",
  "scripts/lib/managed-child-process.mts",
  "scripts/e2e/kitchen-sink-rpc-walk.mts",
  "scripts/control-ui-i18n.ts",
  "scripts/test-docker-all.mts",
  "scripts/run-tsgo-core-test-shards.mts",
  "scripts/check-tsgo-core-boundary.mts",
  "scripts/run-tsgo.mts",
  "scripts/docs-link-audit.mts",
  "scripts/check-openclaw-package-tarball.mts",
  "scripts/test-live-shard.mts",
  "scripts/watch-node.mts",
  "scripts/lib/plugin-npm-runtime-build.mts",
  "scripts/lib/plugin-npm-package-manifest.mts",

  "packages/gateway-client/src/websocket-data.ts",
  "scripts/e2e/parallels/npm-update-smoke.ts",
  "scripts/e2e/parallels/host-command.ts",
  "scripts/e2e/parallels/macos-smoke.ts",
  "scripts/e2e/parallels/update-job-timeout.ts",
  "scripts/anthropic-prompt-probe.ts",
  "scripts/release-verify-beta.ts",
  "scripts/release-verify-publish.ts",
  "scripts/write-cli-startup-metadata.ts",
  "scripts/write-package-dist-inventory.ts",
  "scripts/agent-plugin-gateway-e2e.ts",
  "scripts/run-additional-boundary-checks.mts",
  "scripts/run-with-env.mts",
  "scripts/plugin-sdk-api-diff.mts",
  "scripts/test-projects.mts",
  "scripts/lib/vitest-build-prerequisites.mts",
  "scripts/lib/vitest-batch-runner.mts",
  "scripts/check-memory-fd-repro.mts",
  "scripts/sparkle-build.ts",
  "scripts/crabbox-source-capsule.mts",
  "scripts/crabbox-staging.mts",
  "scripts/crabbox-staging-claims.mts",
  "scripts/crabbox-staging-artifacts.mts",
  "scripts/check-deadcode-exports.mts",
  "scripts/check-deadcode-unused-files.mts",
  "scripts/check-release-metadata-only.mts",
  "scripts/check-gateway-watch-regression.mts",
  "scripts/check-built-plugin-control-plane-modules.mts",
  "scripts/runtime-postbuild.mts",
  "scripts/run-node.mts",
  "scripts/docker-e2e.mts",
  "scripts/docker-e2e-timings.mts",
  "scripts/openclaw-prepack.ts",
  "scripts/openclaw-npm-postpublish-verify.ts",
  "scripts/bench-cli-startup.ts",
  "src/entry.respawn.ts",
  "test/helpers/process-wait.ts",
  "src/gateway/server.ts",
  "src/gateway/server-start.ts",
  "src/process/exec.ts",
  "src/process/spawn-broker/context.ts",
  "src/logging/subsystem.ts",
  "extensions/matrix/src/matrix/config-update.ts",
  "extensions/matrix/src/matrix/account-config.ts",
  "src/secrets/plugin-setup-plan.ts",
  "src/secrets/resolve.ts",
  "src/commands/sessions-cleanup.large-labels.test-support.ts",
  "src/commands/sessions-cleanup.ts",
  "src/commands/session-store-targets.ts",
  "src/config/sessions.ts",
  "src/gateway/call.ts",
  "src/config/sessions/session-sqlite-target.ts",
  "src/commands/sessions-display-model.ts",
  "scripts/build-all.mts",
  "scripts/ci-refit-test-timings.mts",
  "scripts/test-group-report.mts",
  "src/agents/mcp-ui-resource.ts",
  "src/agents/agent-bundle-mcp-runtime.ts",
  "src/agents/agent-bundle-mcp-manager.ts",
  "src/agents/agent-bundle-mcp-manager-api.ts",
  "src/agents/mcp-auth-profile.integration.test-support.ts",
  "src/agents/mcp-auth-profile.ts",
  "src/agents/mcp-auth-profile.runtime.ts",
  "src/agents/auth-profiles/oauth.ts",
  "src/agents/auth-profiles/store.ts",
  "src/worker/worker.runtime.ts",
  "src/worker/launch-descriptor.ts",
  "packages/gateway-protocol/src/schema/worker-admission.ts",
  "src/worker/embedded-agent.runtime.ts",
  "src/worker/inference-stream.runtime.ts",
  "src/cli/mcp-cli.ts",
  "src/agents/agent-bundle-mcp-materialize.ts",
  "src/plugins/tool-metadata.ts",
  "src/plugins/tools.ts",
  "src/plugins/loader.ts",
  "src/mcp/channel-server.ts",
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

// Source-relative script readers retain their exact input bytes in the prepared layout.
export const preservedModuleBuildAssets = [
  "test/fixtures/acp/owner-agent.mjs",
  "scripts/e2e/lib/upgrade-survivor/config-recipe/agents.json",
  "scripts/e2e/lib/upgrade-survivor/config-recipe/channels-discord.json",
  "scripts/e2e/lib/upgrade-survivor/config-recipe/channels-feishu.json",
  "scripts/e2e/lib/upgrade-survivor/config-recipe/channels-matrix.json",
  "scripts/e2e/lib/upgrade-survivor/config-recipe/channels-telegram.json",
  "scripts/e2e/lib/upgrade-survivor/config-recipe/channels-whatsapp.json",
  "scripts/e2e/lib/upgrade-survivor/config-recipe/gateway-password.json",
  "scripts/e2e/lib/upgrade-survivor/config-recipe/gateway.json",
  "scripts/e2e/lib/upgrade-survivor/config-recipe/models-anthropic.json",
  "scripts/e2e/lib/upgrade-survivor/config-recipe/models-google.json",
  "scripts/e2e/lib/upgrade-survivor/config-recipe/models-openai.json",
  "scripts/e2e/lib/upgrade-survivor/config-recipe/plugins-acpx-openclaw-tools-bridge.json",
  "scripts/e2e/lib/upgrade-survivor/config-recipe/plugins-configured-installs.json",
  "scripts/e2e/lib/upgrade-survivor/config-recipe/plugins-feishu.json",
  "scripts/e2e/lib/upgrade-survivor/config-recipe/plugins.json",
  "scripts/e2e/lib/upgrade-survivor/config-recipe/skills.json",
  ".github/workflows/plugin-npm-release.yml",
  "scripts/lib/vitest-worker-bootstrap.mts",
];

// Test-only roots share the invocation generation without changing package entries.
export const vitestWorkerBuildEntries = {
  "legacy-config-binding-repair.runtime":
    "src/commands/doctor/shared/legacy-config-binding-repair.runtime.ts",
  ...createRuntimeProcessBuildEntries([
    ...runtimeProcessBuildEntrypoints,
    benchSessionHistoryEntrypoint,
    ...Object.values(diagnosticProfileEntrypoints),
    ...Object.values(sqliteMaintenanceEntrypoints),
    ...Object.values(processProbeEntrypoints),
    busServerShutdownEntrypoint,
    vectorKnnParentEntrypoint,
    qaOtelSmokeEntrypoint,
    ...Object.values(nativeBoundaryTestEntrypoints),
    ...Object.values(sessionNativeProcessEntrypoints),
    ...Object.values(mediaNativeProcessEntrypoints),
    ...Object.values(proxyCaptureNativeProcessEntrypoints),
    ...Object.values(serviceProcessEnvEntrypoints),
    workerBundleArchiveEntrypoint,
    clawProjectBuildEntrypoint,
    tempDirEntrypoint,
    ...Object.values(deliveryQueueProcessEntrypoints),
    ...Object.values(externalProxyTestEntrypoints),
    ...Object.values(workspaceProcessTestEntrypoints),
    clackPrompterProcessEntrypoint,
    ...Object.values(toolingNativeRuntimeEntrypoints),
    toolingProbeRuntimeEntrypoints.buildArtifactCache,
    toolingProbeRuntimeEntrypoints.buildIdentity,
    ...Object.values(discordAudioTestEntrypoints),
    ...Object.values(realtimeAudioTestEntrypoints),
    quickJsWorkerTestEntrypoint,
    codexCatalogPageWorkerEntrypoint,
    agentWorkerStoreFixtureEntrypoint,
    memoryPublicationFaultEntrypoint,
    sqliteReadOnlyCompileCacheParentEntrypoint,
    ...Object.values(sqliteSnapshotStagingEntrypoints),
    sqliteWorkerStoreCompileCacheParentEntrypoint,
    ...Object.values(nativeProcessTestEntrypoints),
    ...Object.values(storageProcessTestEntrypoints),
    ...Object.values(workerTaskPoolEntrypoints),
    ...Object.values(stateNativeProcessEntrypoints),
    ...Object.values(agentProcessTestEntrypoints),
    ...Object.values(pluginProcessRuntimeEntrypoints),
    ...Object.values(pluginRetentionEntrypoints),
    execOutputRetentionEntrypoint,
    eventHubRetentionEntrypoint,
    eventStreamRetentionEntrypoint,
    ...Object.values(agentCoreRetentionEntrypoints),
    cleanForGeminiEntrypoint,
    tableStackEntrypoint,
    ...Object.values(triageTestRuntimeEntrypoints),
    ...Object.values(triageMaintenanceRuntimeEntrypoints),
    authProfileScopeCwdEntrypoint,
    processPollLivenessEntrypoint,
    codeModeRetentionEntrypoint,
    codeModeDescriptionRetentionEntrypoint,
    ...cliCompactionBackendEntrypoints,
    ...Object.values(bashOutputSpillEntrypoints),
    managedWorktreeGcEntrypoint,
    ...publishedSdkBridgeEntrypoints,
    mcpProviderCatalogEntrypoint,
    mcpPluginToolsServeEntrypoint,
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
    transcriptLibraryTimezoneEntrypoint,
  ]),
  // The real ulimit fixture must import its parent before imposing a file-size limit.
  "infra/sqlite-snapshot-source": "src/infra/sqlite-snapshot-source.ts",
  // Keep provider preparation in the same compiled graph as payload rendering;
  // a source-injected plugin would miss duplicated registry scope state.
  "plugins/provider-hook-runtime": "src/plugins/provider-hook-runtime.ts",
  // Real provider preparation uses packaged JavaScript, avoiding per-child source transforms.
  "extensions/anthropic/index": "extensions/anthropic/index.ts",
  "test-support/anthropic-preparation": "test/scripts/anthropic-preparation-probe.ts",
  "test-support/provider-hook-scope": "test/scripts/provider-hook-scope.test-support.ts",
  // Exercise native writes through the existing plugin facade in the private graph.
  "plugin-sdk/file-access-runtime": "src/plugin-sdk/file-access-runtime.ts",
};
