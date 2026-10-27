/**
 * Knip configuration for OpenClaw root and bundled plugin dependency hygiene.
 */
import fs from "node:fs";
import path from "node:path";
import { collectPluginSourceEntries } from "../scripts/lib/bundled-plugin-build-entries.mjs";
import { createManagedHandoffBuildConfigs } from "../scripts/lib/managed-handoff-build-config.mts";
import { createNativeTypeScriptParser } from "../scripts/lib/native-typescript.mts";
import { runtimeProcessBuildEntries } from "../scripts/lib/runtime-process-build-entries.mts";
import { readUpdateCompatibilityInventory } from "../scripts/lib/update-compat-chunks.mts";
import { ModuleGraph } from "../scripts/lib/update-compat-module-graph.mts";
import { buildPackageDistEntriesFromExports } from "../scripts/lib/workspace-package-entries.mts";
import {
  runtimeProcessScriptEntrypoints,
  runtimeProcessToolingEntrypoints,
} from "../src/infra/runtime-process-manifest.ts";
import { controlUiSource } from "../src/plugins/package-manifest.js";
import aiBuildConfig from "../tsdown.ai.config.ts";
import {
  collectRuntimeProcessManifestEntries,
  compileDynamicConsumerEdges,
} from "./knip-dynamic-consumers.mjs";
import { compileViteConfigConsumers } from "./knip-vite-consumers.mjs";

const BUNDLED_PLUGIN_ROOT_DIR = "extensions";

function bundledPluginFile(pluginId: string, relativePath: string, suffix = ""): string {
  return `${BUNDLED_PLUGIN_ROOT_DIR}/${pluginId}/${relativePath}${suffix}`;
}

// Package scripts, workflows, Docker scenarios, and documented maintainer commands invoke these
// files by path. They are executable roots rather than importable library modules.
const repositoryScriptEntries = [
  // The prepublish registry executes this shared build-and-pack lifetime by path.
  "scripts/lib/plugin-npm-build-and-pack.mts!",
  // Package scripts execute the PostgreSQL schema generator, which consumes state declarations.
  "scripts/generate-postgres-schema.mts!",
  // Package scripts execute these maintained generators, whose inputs are production contracts.
  "scripts/generate-runtime-script-assets.mjs!",
  "scripts/generate-static-validators.mts!",
  // src/daemon/systemd-directives.ts documents this node regeneration command.
  "scripts/generate-systemd-directives.mjs!",
  // ui:validators:gen/check compile canonical payload schemas into browser runtime guards.
  "scripts/generate-control-ui-validators.mts!",
  // Immutable activation and release deployment launch this packaged entry by path.
  "gateway-prewarm.mjs!",
  "apps/linux/scripts/test-runtime-boundary.mjs!",
  "apps/linux/scripts/stage-runtime.mjs!",
  "apps/linux/scripts/test-stage-runtime.mjs!",
  "apps/linux/scripts/test-stage-package.mjs!",
  // The Python onboarding driver installs this synthetic CLI by path.
  "apps/linux/tests/fixtures/onboarding-cli.mjs!",
  // The Linux onboarding proof builds its card fixture through Vite's --config option.
  "apps/linux/tests/fixtures/vite.onboarding.config.ts!",
  // apps/linux/README.md invokes this live Windows native-browser proof driver by path.
  "apps/linux/scripts/test-inline-browser.mjs!",
  // Linux App CI executes the injected native-auth bridge tests through Node.
  "apps/linux/scripts/test-native-control-auth.mjs!",
  // The proof-video skill invokes these image and video CLIs by path.
  "scripts/annotate-proof-image.mts!",
  "scripts/render-proof-video.mts!",
  "scripts/ci-shard-timings-refresh.mts!",
  // The scheduled-run execution context design invokes this development replay by path.
  "scripts/dev/cron-context-replay.mts!",
  // #183131 invokes this fresh-process cron flake workload by path.
  "scripts/perf/repeat-cron-test.mjs!",
  // Its header documents the paired operator-role currency-check benchmark.
  "scripts/perf/operator-role-source-policy-measure.mjs!",
  "scripts/perf/access-authority-callback-measure.mjs!",
  "scripts/perf/plugin-registry-binding-measure.mjs!",
  // Its header documents the config-wide admission metadata benchmark.
  "scripts/perf/config-wide-metadata-measure.ts!",
  // Its header documents the sandbox/workspace ownership assertion benchmark.
  "scripts/perf/workspace-assertion-measure.mjs!",
  // Its header documents the paired workspace reconciliation benchmark.
  "scripts/perf/workspace-manifest-comparison.ts!",
  "scripts/perf/state-owner-identity-measure.mjs!",
  // Its header documents the full transcript-pairing repair benchmark.
  "scripts/perf/tool-result-pairing-measure.ts!",
  "scripts/perf/assistant-thinking-measure.ts!",
  // Its header documents leaf SELF-byte attribution of sampled survivor profiles.
  "scripts/perf/survivor-leaf-rank.mjs!",
  // db:postgres:gen/check invoke this generator through the source loader.
  "scripts/generate-postgres-schema.mts!",
  // CI preflight executes the manifest from its trusted harness checkout.
  "scripts/ci-build-manifest.mjs!",
  // CI security-fast runs this from its trusted harness checkout.
  "scripts/ci-production-audit.mjs!",
  // tsdown builds this private macOS app worker protocol entry by path.
  "src/node-host/mac-worker-entry.ts!",
  // CI imports this selector from its trusted harness inside an inline Node script.
  ".github/actions/git-owner/test-prerequisites.mjs!",
  // The frozen Node compatibility action invokes this exact-candidate repair by path.
  ".github/actions/frozen-node-test-compat/apply.mjs!",
  // The compiler below exposes this workflow's inline and generated-config imports.
  ".github/workflows/plugin-prerelease.yml!",
  // Labeler steps import their shared helper through workspace file URLs.
  ".github/workflows/labeler.yml!",
  // Prepared publication imports its verifier from the frozen release harness.
  ".github/workflows/openclaw-release-publish.yml!",
  // setup-node-env invokes this helper from composite-action YAML.
  ".github/actions/setup-node-env/dependency-fingerprint.mjs!",
  ".github/actions/setup-node-env/seed-bun-from-image.mjs!",
  // setup-pnpm-store-cache invokes this helper from composite-action YAML.
  ".github/actions/setup-pnpm-store-cache/seed-pnpm-from-image.mjs!",
  "apps/android/scripts/build-release-artifacts.ts!",
  // scripts/README.md invokes this warm-interaction benchmark CLI by path.
  "scripts/bench-control-ui-interactions.ts!",
  // scripts/README.md invokes the Chromium/WebKit companion with shared scenarios.
  "scripts/bench-control-ui-engines.ts!",
  // The opt-in projection benchmark builds its browser fixture through this CLI.
  "scripts/build-control-ui-projection-fixture.mts!",
  // The reactive graph guide invokes this isolated diagnostic build by path.
  "scripts/build-control-ui-reactive-graph.mts!",
  // scripts/README.md invokes these exact memory-search benchmarks by path.
  "scripts/bench-memory-search.mjs!",
  "scripts/bench-memory-search-sqlite.mjs!",
  // scripts/perf/README.md invokes this Gateway search-count workload and its worker preload.
  "scripts/perf/memory-search-status-measure.ts!",
  "scripts/perf/memory-search-status-observer.cjs!",
  // #180983 invokes this isolated plugin-registration benchmark CLI by path.
  "scripts/bench-plugin-registration.mts!",
  // The cold-load benchmark guide invokes this opt-in CLI by path.
  "scripts/bench-control-ui-cold-load.ts!",
  // scripts/perf/warm-reload-proof.md invokes this real-Gateway visual proof loop.
  "scripts/perf/warm-reload-proof.ts!",
  // scripts/control-ui-retention/README.md invokes this opt-in production census.
  "scripts/control-ui-retention/retention-suite.ts!",
  // #179175 invokes this development-loop benchmark CLI by path.
  "scripts/bench-control-ui-dev-loop.mts!",
  // #179449 documents this document-handler benchmark CLI by path.
  "scripts/bench-control-ui-document.ts!",
  // The channel-turn benchmark guide invokes this opt-in CLI by path.
  "scripts/bench-channel-turn.mts!",
  // The guide's async-context census wrapper imports this preload before the channel-turn entry.
  "scripts/perf/async-context-probe.cjs!",
  // The transcript-broadcast benchmark loads this fsync probe through --entry.
  "scripts/perf/fsync-gateway-entry.ts!",
  // scripts/perf/README.md invokes this fsync scratch measurement through Node.
  "scripts/perf/fsync-scratch-measure.ts!",
  // scripts/perf/README.md invokes this database page-cache benchmark by path.
  "scripts/perf/database-page-cache-measure.ts!",
  // The ACP eviction PR invokes this isolated stdio/Gateway workload by path.
  "scripts/perf/acp-ledger-eviction-measure.ts!",
  "scripts/perf/plugin-blob-registration-measure.ts!",
  "scripts/perf/session-reaction-quota-measure.ts!",
  // Maintained guides, source headers, and paired drivers invoke these roots by path.
  "scripts/perf/audit-batch-write-measure.ts!",
  "scripts/perf/prompt-suffix-turn-context-measure.ts!",
  "scripts/perf/audit-context-write-measure.ts!",
  "scripts/perf/node-worker-journal-measure.ts!",
  "scripts/perf/orphan-recovery-observer.mjs!",
  "scripts/perf/pairing-channel-attribution.mts!",
  "scripts/perf/session-actor-residency-snapshot.mjs!",
  "scripts/perf/session-actor-retention-seed.ts!",
  "scripts/perf/session-cold-selection.ts!",
  "scripts/perf/session-entry-projection-measure.ts!",
  "scripts/perf/session-row-index-measure.ts!",
  "scripts/perf/session-row-materialization-measure.ts!",
  "scripts/perf/session-row-refresh-measure.ts!",
  "scripts/perf/session-row-consume-measure.ts!",
  "scripts/perf/session-row-lineage-measure.ts!",
  "scripts/perf/session-event-ancestors-measure.ts!",
  "scripts/perf/tool-result-hash-measure.ts!",
  "scripts/perf/tool-result-size-measure.ts!",
  "scripts/perf/ws-counter-stress-preload.ts!",
  "scripts/perf/ws-counter-stress.ts!",
  // The source header documents this GitHub reader benchmark's Node command.
  "scripts/perf/github-reader-measure.ts!",
  // scripts/perf/pairing-live-measure.md invokes this synthetic pairing workload by path.
  "scripts/perf/pairing-live-measure.mts!",
  // docs/reference/test/performance.md invokes the Decision transport comparison driver.
  "scripts/bench-decision-transport.mts!",
  // docs/reference/test/performance.md invokes the frozen-revision benchmark builder.
  "scripts/build-decision-transport-bench.mts!",
  // scripts/perf/README.md invokes this shared-writer benchmark by path.
  "scripts/bench-channel-ingress-writer.ts!",
  // The performance guide invokes these measurement commands by path.
  "scripts/perf/adoption-candidates-measure.ts!",
  "scripts/perf/background-result-wait-measure.ts!",
  // #181383 invokes this committed Bash-output benchmark by path from a source checkout.
  "scripts/perf/bash-output-measure.ts!",
  "scripts/perf/codex-process-inspection-measure.ts!",
  "scripts/perf/diagnostic-profile-measure.ts!",
  "scripts/perf/owned-directory-events-measure.ts!",
  "scripts/perf/plugin-gateway-scope-measure.ts!",
  "scripts/perf/plugin-tool-resolution-measure.ts!",
  // pg-footprint.md and the pool proof commands execute these entries by path.
  "scripts/perf/pg-footprint.ts!",
  "scripts/perf/pg-footprint-preload.mjs!",
  "scripts/perf/pg-footprint-topology.mjs!",
  "scripts/perf/pg-pool-lifecycle.mts!",
  "scripts/perf/pg-pool-topology.mts!",
  // The lifecycle proof passes these fixture entries through computed worker URLs.
  "scripts/perf/pg-pool-broker.fixture.mts!",
  "scripts/perf/pg-pool-hang.worker.mjs!",
  // #181150 invokes this reproducible session-row owner probe by path.
  "scripts/perf/session-actor-row-facts-measure.ts!",
  "scripts/perf/session-catalog-selection-measure.ts!",
  // The offline health-cron measurement invokes this synthetic fixture by path.
  "scripts/perf/health-cron-fixture.ts!",
  // #183020 invokes this synthetic category-registration workload by path.
  "scripts/perf/session-group-registration-measure.ts!",
  // Its source header documents this owner-level field-order benchmark.
  "scripts/perf/session-event-field-order.ts!",
  "scripts/perf/session-array-encoding.ts!",
  "scripts/perf/session-pr-subscriptions-measure.ts!",
  "scripts/perf/session-tool-surface-measure.ts!",
  "scripts/perf/subagent-maintenance-capture-measure.ts!",
  "scripts/perf/subagent-sweep-measure.ts!",
  "scripts/perf/subagent-timing-write-measure.ts!",
  // Its source header documents the shutdown workload; the literal URL links its preload.
  "scripts/perf/gateway-shutdown-sweep-measure.ts!",
  "scripts/perf/tool-schema-preparation-measure.ts!",
  "scripts/perf/terminal-assistant-snapshot-measure.ts!",
  // Their source headers and retained guide document standalone Node commands.
  "scripts/perf/cheaper-retry-logging.ts!",
  "scripts/perf/hook-message-loader-retention.ts!",
  "scripts/perf/jiti-stack-format.ts!",
  "scripts/perf/pr-restore-memory.mjs!",
  "scripts/perf/session-cold-restore-memory.ts!",
  "scripts/perf/subagent-custody-abort-retention.ts!",
  "scripts/perf/worker-lifecycle-message-measure.ts!",
  // Retained source commands and selectable preloads execute directly by exact path.
  "scripts/perf/after-turn-context-measure.ts!",
  "scripts/perf/agent-runtime-dispatch-measure.ts!",
  "scripts/perf/approval-replay-burst-measure.ts!",
  "scripts/perf/channels-status-inventory.ts!",
  "scripts/perf/extension-handler-lookup-measure.ts!",
  "scripts/perf/extension-context-copy-measure.ts!",
  "scripts/perf/knowledge-git-transactions.ts!",
  "scripts/perf/reply-tool-authority-measure.ts!",
  "scripts/perf/select-environment-scale.ts!",
  "scripts/perf/session-archive-staging-measure.ts!",
  "scripts/perf/session-delete-measure.ts!",
  "scripts/perf/session-history-prewarm-measure.mjs!",
  "scripts/perf/session-prepared-list-measure.ts!",
  "scripts/perf/session-list-search-measure.ts!",
  "scripts/perf/session-list-transmit-measure.mjs!",
  "scripts/perf/transcript-boot-preload.mjs!",
  "scripts/perf/worker-pool-churn-preload.mjs!",
  "scripts/perf/worktree-prompt-native-measure.ts!",
  "scripts/perf/worktree-prompt-overlap-measure.ts!",
  "scripts/perf/code-mode-worker-burst-measure.ts!",
  "scripts/perf/code-mode-worker-residency-measure.ts!",
  "scripts/perf/embedded-subscribe-events-measure.ts!",
  "scripts/perf/harness-selection-copy-measure.ts!",
  "scripts/perf/session-catalog-pairing-measure.ts!",
  "scripts/perf/session-involvement-measure.ts!",
  "scripts/perf/sqlite-native-lease-measure.mjs!",
  "scripts/perf/agent-db-close-receipt-measure.mjs!",
  "scripts/perf/sqlite-owner-dispatch-measure.mjs!",
  "scripts/perf/sqlite-wal-scan-measure.mjs!",
  "scripts/perf/state-engine-schema-bench.ts!",
  "scripts/perf/state-read-boot-bench.ts!",
  "scripts/perf/state-read-import-bench.mjs!",
  // Knip follows the private Gateway boot preload through this parent's literal URL edge.
  "scripts/perf/state-read-gateway-boot.ts!",
  "scripts/perf/worktree-snapshot-measure.ts!",
  "scripts/perf/attempt-stop-reason-stream-measure.ts!",
  "scripts/perf/codex-inference-terminal-measure.ts!",
  "scripts/perf/codex-inference-upload-measure.ts!",
  "scripts/perf/codex-tool-report-measure.ts!",
  "scripts/perf/codex-config-parse-measure.ts!",
  "scripts/perf/failed-placement-recovery-bench.ts!",
  "scripts/perf/provider-prompt-state-worker-measure.mjs!",
  "scripts/perf/session-diff-metadata-measure.ts!",
  "scripts/perf/session-file-workspace-measure.ts!",
  "scripts/perf/session-files-list-measure.ts!",
  // The performance guide and transcript driver invoke these tools and preloads by path.
  "scripts/lib/gateway-bench-transport-preload.ts!",
  "scripts/perf/async-store-measure.mjs!",
  "scripts/perf/code-mode-store-measure.ts!",
  // Its header documents the long-history session-store replay benchmark.
  "scripts/perf/code-mode-store-replay-measure.ts!",
  "scripts/perf/gateway-agent-event-measure.ts!",
  "scripts/perf/transcript-hydration-counts-preload.ts!",
  // The performance guide and retained package-integrity rerun invoke these benchmarks by path.
  "scripts/bench-package-integrity.ts!",
  "scripts/perf/provider-request-prepare-measure.ts!",
  // Invoked directly with Node as documented in its header.
  "scripts/perf/attempt-stream-options-measure.ts!",
  "scripts/perf/attempt-prompt-context-measure.ts!",
  "scripts/perf/current-prompt-history-measure.ts!",
  "scripts/perf/session-profile-reference-measure.ts!",
  "scripts/perf/worker-task-metrics-measure.ts!",
  // scripts/perf/README.md invokes this worker protocol benchmark by path.
  "scripts/perf/worker-module-graphs-measure.mjs!",
  // Its header documents the built-worker nursery and natural-idle comparison.
  "scripts/perf/worker-young-generation-measure.mjs!",
  // scripts/perf/README.md invokes this cold usage-cache measurement CLI by path.
  "scripts/perf/chat-metadata-burst-measure.ts!",
  // scripts/perf/README.md invokes this model-prompt statistics measurement CLI by path.
  "scripts/perf/model-prompt-stats-measure.ts!",
  // scripts/perf/README.md invokes this synthetic mention Inbox benchmark by path.
  "scripts/perf/mention-inbox-measure.ts!",
  // scripts/perf/README.md invokes this main-thread stall measurement CLI by path.
  "scripts/perf/main-thread-stall-measure.mjs!",
  // Cold-load diagnostics invoked directly as documented in their headers.
  "scripts/perf/gateway-main-heap-preload.mjs!",
  "scripts/perf/headless-tools-cold-import.mjs!",
  "scripts/perf/session-actor-append-measure.ts!",
  // scripts/perf/README.md invokes these measurement commands by path.
  "scripts/perf/cron-delivery-gateway-entry.ts!",
  "scripts/perf/plugin-policy-read-measure.mjs!",
  "scripts/perf/prompt-cache-observation-measure.ts!",
  // Invoked directly with Node as documented in their headers.
  "scripts/perf/prompt-cache-drops-measure.ts!",
  "scripts/perf/prompt-cache-request-cost.ts!",
  "scripts/perf/live-history-observation-measure.ts!",
  "scripts/perf/reconnect-read-wave-measure.ts!",
  "scripts/perf/session-actor-receipt-measure.ts!",
  "scripts/perf/session-actor-retention-measure.ts!",
  // The row-churn instrumenter injects this probe from its compiled source path.
  "scripts/perf/session-row-churn-probe.ts!",
  // scripts/perf/README.md invokes this synthetic reload fixture by path.
  "scripts/perf/control-ui-reload-fixture.ts!",
  // docs/ci/checkout.md invokes this checkout materialization benchmark by path.
  "scripts/perf/ci-preflight-checkout-measure.mjs!",
  // The narration payload benchmark in #179092 is invoked by path.
  "scripts/perf/tool-frame-replay.ts!",
  // scripts/perf/README.md invokes these drivers and their worker-memory preload.
  "scripts/perf/workboard-read-measure.ts!",
  "scripts/perf/transcript-hydration-headroom.ts!",
  "scripts/perf/transcript-worker-memory-preload.ts!",
  // transcript-broadcast-measure.ts preloads this stage probe with --import.
  "scripts/perf/github-options-measure-preload.ts!",
  // scripts/perf/README.md invokes this prompt-history fingerprint benchmark by path.
  "scripts/perf/prompt-cache-history-measure.ts!",
  // scripts/perf/README.md invokes this synthetic authority allocation probe by path.
  "scripts/perf/operator-authority-measure.ts!",
  // The transcript driver selects this diagnostic preload through --gateway-preload.
  "scripts/perf/plugin-access-authority-census.mjs!",
  // #179149 invokes this synthetic event-dispatch allocation probe by path.
  "scripts/perf/agent-event-dispatch-measure.ts!",
  // scripts/perf/README.md invokes this WebSocket diagnostic accounting benchmark.
  "scripts/perf/ws-event-diagnostics-measure.ts!",
  // scripts/perf/README.md invokes this database-path allocation probe by path.
  "scripts/perf/state-path-resolution-measure.ts!",
  // Maintained guides and source headers invoke these proof commands by exact path.
  "scripts/bench-control-ui-media.ts!",
  "scripts/bench-control-ui-css.ts!",
  "scripts/bench-control-ui-reconnect.ts!",
  "scripts/bench-control-ui-rich-boot.ts!",
  "scripts/bench-control-ui-wire.ts!",
  "scripts/bench-dynamic-validators.mts!",
  "scripts/bench-standalone-wasm.mjs!",
  "scripts/generate-social-preview.mts!",
  "scripts/perf/audio-queue-pool-retention.ts!",
  "scripts/perf/browser-playwright-import.mjs!",
  "scripts/perf/browser-playwright-load.ts!",
  "scripts/perf/catalog-worker-retention-measure.ts!",
  "scripts/perf/codex-catalog-reconcile-measure.ts!",
  "scripts/perf/codex-catalog-rollouts.ts!",
  "scripts/perf/command-capture-pool-retention.ts!",
  "scripts/perf/control-ui-forbidden-rpc-measure.ts!",
  "scripts/perf/device-pairing-publication-measure.ts!",
  "scripts/perf/diagnostic-private-data-measure.ts!",
  "scripts/perf/finalized-tool-schemas-measure.ts!",
  "scripts/perf/fsync-tts-gateway-measure.ts!",
  "scripts/perf/gateway-buffer-pool-retention.ts!",
  "scripts/perf/gateway-state-owner-measure.ts!",
  "scripts/perf/managed-attachment-cleanup-measure.mjs!",
  "scripts/perf/model-stream-observation-measure.ts!",
  "scripts/perf/pending-input-retention.ts!",
  "scripts/perf/placement-preservation-measure.ts!",
  "scripts/perf/plugin-inspection-retention.ts!",
  "scripts/perf/plugin-invocation-scope-measure.ts!",
  "scripts/perf/plugin-state-polling.mts!",
  "scripts/perf/private-array-copies-measure.mjs!",
  "scripts/perf/process-output-pool-retention.ts!",
  "scripts/perf/queued-input-retention.ts!",
  "scripts/perf/queued-input-retention-preload.mjs!",
  "scripts/perf/pty-session-scan-measure.mjs!",
  "scripts/perf/publication-empty-recovery-measure.ts!",
  "scripts/perf/publication-spawn-measure.ts!",
  "scripts/perf/replay-history-measure.ts!",
  "scripts/perf/run-tool-validation-retention.ts!",
  "scripts/perf/session-actor-listener-measure.ts!",
  "scripts/perf/session-authority-retention.ts!",
  "scripts/perf/session-fork-retention-measure.mjs!",
  "scripts/perf/session-history-reader-setup-measure.mjs!",
  "scripts/perf/session-summary-id-retention.ts!",
  "scripts/perf/skill-resource-delivery-measure.ts!",
  "scripts/perf/sqlite-admission-release-measure.mjs!",
  "scripts/perf/sqlite-reply-transfer-measure.mjs!",
  "scripts/perf/system-prompt-report-retention.ts!",
  "scripts/perf/transcript-context-clone-measure.ts!",
  "scripts/perf/transcript-size-memo-measure.mjs!",
  "scripts/perf/update-doctor-generation-measure.ts!",
  "scripts/perf/worker-cpu-measure.ts!",
  "scripts/perf/ws-compression-measure.ts!",
  "scripts/bench-codex-validators.mts!",
  "scripts/bench-control-ui-navigation.ts!",
  "scripts/bench-gateway-validators.mts!",
  "scripts/bench-ingress-polling.mts!",
  "scripts/bench-lobster-validators.mts!",
  "scripts/bench-media-completion-gateway.mts!",
  "scripts/bench-media-completion-wait.mts!",
  "scripts/bench-memory-keyword.mjs!",
  "scripts/bench-session-cost-ready.mts!",
  "scripts/bench-session-projection-ready.mts!",
  "scripts/perf/bench-postgres-ann-decision.mjs!",
  "scripts/perf/bench-postgres-ann-publication.mjs!",
  "scripts/perf/child-memory-adaptive-runaway.ts!",
  "scripts/perf/child-memory-measure.ts!",
  "scripts/perf/diagnostic-event-clone-measure.ts!",
  "scripts/perf/doctor-tool-schemas-measure.ts!",
  "scripts/perf/hook-isolation-measure.ts!",
  "scripts/perf/managed-git-maintenance-measure.ts!",
  "scripts/perf/pending-input-read-measure.ts!",
  "scripts/perf/plugin-source-demand.mts!",
  "scripts/perf/responses-continuation-measure.mjs!",
  "scripts/perf/responses-continuation.ts!",
  "scripts/perf/responses-history-conversion.ts!",
  "scripts/perf/schema-validator-cache-measure.ts!",
  "scripts/perf/session-lifecycle-boot.ts!",
  "scripts/perf/shared-skills-measure.ts!",
  "scripts/perf/sqlite-snapshot-maintenance.mjs!",
  "scripts/perf/system-prompt-pool-retention.ts!",
  // Maintained source headers, guides, and recorded proof commands invoke these exact roots.
  "scripts/bench-control-ui-route-leaks.ts!",
  "scripts/bench-plugin-views.ts!",
  "scripts/perf/agent-db-borrower-gateway-proof.ts!",
  "scripts/perf/agent-revalidation.ts!",
  "scripts/perf/agent-roster-ids-measure.ts!",
  "scripts/perf/agent-roster-validation-measure.mjs!",
  "scripts/perf/attempt-abort-retention.ts!",
  "scripts/perf/board-get-measure.mjs!",
  "scripts/perf/board-layout-measure.mjs!",
  "scripts/perf/channel-run-admission-measure.mjs!",
  "scripts/perf/chat-history-param-validation-measure.mjs!",
  "scripts/perf/claude-session-catalog-measure.ts!",
  "scripts/perf/codex-catalog-hydrate-measure.ts!",
  "scripts/perf/cron-continuation-snapshot-measure.ts!",
  "scripts/perf/cron-history-plan-measure.ts!",
  "scripts/perf/cron-list-projection-measure.mjs!",
  "scripts/perf/cron-list-revision-measure.ts!",
  "scripts/perf/cron-delivery-context-measure.mjs!",
  "scripts/perf/cron-refresh-measure.ts!",
  "scripts/perf/cron-session-bindings-measure.ts!",
  "scripts/perf/embedded-runner-array-copies.ts!",
  "scripts/perf/gateway-clone-measure.ts!",
  "scripts/perf/gateway-snapshot-freeze-measure.mjs!",
  "scripts/perf/gateway-ui-rpc-measure.ts!",
  "scripts/perf/github-base-refresh-measure.ts!",
  "scripts/perf/harness-tool-authority-measure.ts!",
  "scripts/perf/ingress-blocked-lanes.ts!",
  "scripts/perf/lease-main-thread-renewal.mjs!",
  "scripts/perf/media-selection-measure.ts!",
  "scripts/perf/model-catalog-runtime-measure.ts!",
  "scripts/perf/models-list-read-measure.ts!",
  "scripts/perf/model-suppression-resolver.ts!",
  "scripts/perf/node-event-session-source-measure.mjs!",
  "scripts/perf/onboarding-readback-measure.ts!",
  "scripts/perf/owned-snapshot-copies-measure.mjs!",
  "scripts/perf/plugin-config-publication-measure.mjs!",
  "scripts/perf/plugin-metadata-frame-measure.ts!",
  "scripts/perf/plugin-sdk-defensive-measure.ts!",
  "scripts/perf/plugin-session-action-measure.ts!",
  "scripts/perf/presence-delivery-measure.ts!",
  "scripts/perf/project-publication-fetch-measure.ts!",
  "scripts/perf/provider-rate-limit-http-retention.ts!",
  "scripts/perf/provider-route-overrides.ts!",
  "scripts/perf/reply-classification-publication-measure.ts!",
  "scripts/perf/runtime-source-projection-measure.ts!",
  "scripts/perf/session-child-owner-measure.ts!",
  "scripts/perf/session-initialization-measure.ts!",
  "scripts/perf/session-list-order-measure.mjs!",
  "scripts/perf/gateway-session-store-shapes.mjs!",
  "scripts/perf/session-pr-currency-measure.ts!",
  "scripts/perf/session-run-progress-measure.ts!",
  "scripts/perf/session-tool-pin-measure.ts!",
  "scripts/perf/sidebar-presentation-measure.ts!",
  "scripts/perf/sidebar-fact-sharing-measure.ts!",
  "scripts/perf/session-partition-metrics-measure.ts!",
  "scripts/perf/source-kind-progress-equality-measure.ts!",
  "scripts/perf/sqlite-reclamation-retention.ts!",
  "scripts/perf/state-db-cache-admission-measure.ts!",
  "scripts/perf/stream-dispatch-scope-measure.ts!",
  "scripts/perf/subagent-mutation-clone-measure.ts!",
  "scripts/perf/telegram-entity-sort-measure.mjs!",
  "scripts/perf/telegram-token-owner-measure.mjs!",
  "scripts/perf/tool-result-owned-freeze-measure.ts!",
  "scripts/perf/tool-search-allowlist-measure.ts!",
  "scripts/perf/tools-catalog-copy-measure.ts!",
  "scripts/perf/session-catalog-entry-snapshot-measure.ts!",
  // Standalone owner benchmark; invocation is documented in its header.
  "scripts/perf/model-tool-projection-measure.ts!",
  "scripts/perf/trajectory-skills-metadata-measure.ts!",
  "scripts/perf/transcript-checkpoint-retention.ts!",
  "scripts/perf/trusted-tool-matcher-measure.mjs!",
  "scripts/perf/turn-participants-measure.ts!",
  "scripts/perf/usage-aggregate-measure.ts!",
  "scripts/perf/user-github-readback-measure.ts!",
  "scripts/perf/worker-reconcile-shutdown.ts!",
  "scripts/perf/worker-request-diagnostics-measure.ts!",
  "scripts/perf/worker-transcript-batch-measure.ts!",
  // Maintained source headers invoke these standalone measurement commands by exact path.
  "scripts/perf/active-node-turn-prepare-measure.ts!",
  "scripts/perf/agent-fresh-array-copy-measure.ts!",
  "scripts/perf/agent-object-copy-measure.ts!",
  "scripts/perf/agent-stream-update-measure.ts!",
  "scripts/perf/agent-turn-taint-measure.ts!",
  "scripts/perf/auth-availability-invalidation-measure.ts!",
  "scripts/perf/chat-admission-freshness-measure.ts!",
  "scripts/perf/chat-display-admission-measure.mjs!",
  "scripts/perf/core-fresh-array-copies-measure.mjs!",
  "scripts/perf/delivery-info-measure.ts!",
  "scripts/perf/extension-defensive-measure.ts!",
  "scripts/perf/gateway-fresh-array-measure.ts!",
  "scripts/perf/host-cpu-sample-measure.mjs!",
  "scripts/perf/identifier-renormalization-measure.ts!",
  "scripts/perf/ingress-ip-measure.ts!",
  "scripts/perf/inter-session-steering-measure.ts!",
  "scripts/perf/memory-ranking-copies.ts!",
  "scripts/perf/memory-prompt-copy-measure.ts!",
  "scripts/perf/misc-fresh-array-copies-measure.mjs!",
  "scripts/perf/native-control-port-measure.ts!",
  "scripts/perf/plugin-fresh-arrays-measure.mjs!",
  "scripts/perf/placement-session-evidence-measure.ts!",
  "scripts/perf/plugin-registry-normalizer-measure.ts!",
  "scripts/perf/prompt-image-sanitation-measure.ts!",
  "scripts/perf/provider-auth-lookup-maps-measure.ts!",
  "scripts/perf/provider-request-preparation-measure.ts!",
  "scripts/perf/quadratic-report-measure.ts!",
  "scripts/perf/reef-device-sign-measure.ts!",
  "scripts/perf/session-actor-admission-measure.ts!",
  "scripts/perf/session-input-custody-measure.ts!",
  "scripts/perf/chat-send-persist-measure.ts!",
  "scripts/perf/session-pin-policy-measure.ts!",
  "scripts/perf/session-prompt-begin-measure.ts!",
  "scripts/perf/session-store-target-inventory-measure.ts!",
  "scripts/perf/session-discovery-payload-measure.mjs!",
  "scripts/perf/state-read-transport-bench.ts!",
  "scripts/perf/subagent-run-retention-gateway.ts!",
  "scripts/perf/subagent-run-retention-measure.ts!",
  "scripts/perf/subagent-runtime-registry-measure.ts!",
  "scripts/perf/transcript-payload-prepare-measure.ts!",
  "scripts/perf/transcript-resident-hydration-measure.ts!",
  "scripts/perf/transcript-selected-payload-measure.ts!",
  "scripts/perf/transcript-active-read-measure.ts!",
  "scripts/perf/worker-task-input-measure.mjs!",
  "scripts/perf/worktree-provisioning-gateway-measure.ts!",
  "scripts/perf/worktree-provisioning-measure.ts!",
  // Maintained source headers and a dedicated guide invoke these standalone commands by exact path.
  "scripts/perf/attempt-tool-context-measure.ts!",
  "scripts/perf/catalog-retained-data-measure.ts!",
  "scripts/perf/disk-budget-scan.ts!",
  "scripts/perf/git-operation-allocation-measure.ts!",
  "scripts/perf/long-lived-error-stacks-measure.ts!",
  "scripts/perf/mcp-http-dispatcher-measure.ts!",
  "scripts/perf/mcp-namespace-result-measure.ts!",
  "scripts/perf/model-catalog-read-startup-measure.mjs!",
  "scripts/perf/model-stream-scheduler-measure.ts!",
  "scripts/perf/node-bootstrap-runtime-chunks-measure.ts!",
  "scripts/perf/openai-sdk-stream-measure.ts!",
  "scripts/perf/openai-sse-decode-measure.ts!",
  "scripts/perf/placement-recovery-reads-bench.ts!",
  "scripts/perf/plain-tool-brace-measure.ts!",
  "scripts/perf/plugin-cache-stat-facts.ts!",
  // Its header documents the paired metadata-root allocation benchmark.
  "scripts/perf/plugin-cache-root-measure.ts!",
  "scripts/perf/plugin-preparation-boot.mjs!",
  "scripts/perf/plugin-preparation-boot-preload.mjs!",
  "scripts/perf/plugin-relative-path-measure.ts!",
  "scripts/perf/plugin-capture-stat-measure.ts!",
  "scripts/perf/plugin-source-preparation.ts!",
  "scripts/perf/plugin-transform-preload.mjs!",
  "scripts/perf/prepared-gateway-startup-measure.mjs!",
  "scripts/perf/sandbox-paths-measure.ts!",
  "scripts/perf/sandbox-skills-sync-measure.ts!",
  "scripts/perf/sandbox-start-measure.ts!",
  "scripts/perf/sandbox-status-measure.ts!",
  "scripts/perf/session-projection-stream-measure.ts!",
  "scripts/perf/session-sharing-key-measure.ts!",
  "scripts/perf/session-store-key-measure.ts!",
  "scripts/perf/session-store-summary-measure.ts!",
  "scripts/perf/session-transcript-catalog-measure.ts!",
  "scripts/perf/slack-send-preparation-measure.ts!",
  "scripts/perf/sqlite-operation-finish-measure.ts!",
  "scripts/perf/startup-plugin-borrow.ts!",
  "scripts/perf/state-read-workspace-bench.ts!",
  "scripts/perf/system-prompt-persist-measure.ts!",
  "scripts/perf/tiny-worker-census.mjs!",
  "scripts/perf/tool-schema-inspection-measure.ts!",
  "scripts/perf/trajectory-attempt-metadata-measure.ts!",
  "scripts/perf/trajectory-tool-parameters-measure.ts!",
  "scripts/perf/transcript-projection-receipt-measure.ts!",
  "scripts/perf/ui-streaming-render-measure.ts!",
  // Their source headers document these standalone performance commands.
  "scripts/perf/active-run-projector-measure.ts!",
  "scripts/perf/cron-store-context-measure.ts!",
  "scripts/perf/diagnostic-frozen-trace-measure.ts!",
  "scripts/perf/image-worker-buffers-measure.mjs!",
  "scripts/perf/installed-plugin-index-fingerprint-measure.ts!",
  "scripts/perf/knowledge-worker-diagnostics-measure.mjs!",
  "scripts/perf/knowledge-worker-heap-measure.mjs!",
  // These source headers document standalone measurement commands.
  "scripts/perf/agent-deletion-blocked-measure.ts!",
  "scripts/perf/agent-list-read-measure.ts!",
  "scripts/perf/chat-history-response-page-measure.mjs!",
  "scripts/perf/chat-history-tool-text-measure.mjs!",
  "scripts/perf/chat-metadata-auth-check-measure.ts!",
  "scripts/perf/config-schema-retention-measure.ts!",
  "scripts/perf/sandbox-retirement-authority.ts!",
  "scripts/perf/subagent-registration-retention.ts!",
  "scripts/perf/system-prompt-request-measure.ts!",
  "scripts/perf/worktree-index-metadata-measure.ts!",
  "scripts/perf/worktree-preparation-index-measure.ts!",
  // Maintained source headers invoke these standalone commands by exact path.
  "scripts/perf/archive-worker-startup-measure.mjs!",
  "scripts/perf/archive-canonical-worker-measure.ts!",
  "scripts/perf/attempt-stream-repair-measure.ts!",
  "scripts/perf/config-health-read-measure.ts!",
  "scripts/perf/context-engine-lifecycle-bench.ts!",
  "scripts/perf/mcp-oauth-startup.ts!",
  "scripts/perf/node-bootstrap-artifact-measure.ts!",
  "scripts/perf/placement-identity-recovery-bench.ts!",
  "scripts/perf/provider-tool-normalization-measure.ts!",
  "scripts/perf/session-entry-patch-prepare-measure.ts!",
  "scripts/perf/session-internal-patch-measure.ts!",
  "scripts/perf/session-lifecycle-prepare-measure.ts!",
  "scripts/perf/session-replacement-write-measure.ts!",
  "scripts/perf/session-patch-label-owner-measure.ts!",
  "scripts/perf/session-patch-result-measure.mjs!",
  "scripts/perf/session-event-audience-measure.ts!",
  "scripts/perf/transcript-snapshot-copy-measure.ts!",
  "scripts/perf/turn-start-phases.ts!",
  "scripts/perf/update-manager-measure.ts!",
  "scripts/perf/worker-spawn-measure.mjs!",
  "scripts/perf/worktree-size-measure.ts!",
  // Maintained source headers and callers invoke these commands, module entries, and preloads by path.
  "scripts/perf/agent-directory-recovery-measure.ts!",
  "scripts/perf/agent-event-frame-census-preload.mjs!",
  "scripts/perf/artifacts-block-measure.ts!",
  "scripts/perf/attachment-header-measure.ts!",
  "scripts/perf/chat-history-activity-transfer-measure.mjs!",
  "scripts/perf/chat-send-attachments-measure.ts!",
  "scripts/perf/stage-media-measure.ts!",
  "scripts/perf/codex-catalog-lines.ts!",
  "scripts/perf/codex-request-imports.ts!",
  "scripts/perf/empty-checkout-diff-measure.ts!",
  "scripts/perf/exec-approvals-idle-measure.ts!",
  "scripts/perf/exec-approvals-receipt-measure.ts!",
  "scripts/perf/knowledge-resume.ts!",
  "scripts/perf/local-workspace-manifest-contention-measure.ts!",
  "scripts/perf/matrix-idle-persistence.ts!",
  "scripts/perf/project-checkout-options-measure.ts!",
  "scripts/perf/main-module-census-report.mjs!",
  "scripts/perf/module-import-measure.mjs!",
  "scripts/perf/plugin-resolve-hooks-measure.ts!",
  "scripts/perf/plugin-sdk-resolve-measure.ts!",
  "scripts/perf/plugins-list-catalog-preload.mjs!",
  "scripts/perf/presence-projection-measure.ts!",
  "scripts/perf/prepared-catalog-handoff-measure.ts!",
  "scripts/perf/prompt-cache-facts-measure.ts!",
  "scripts/perf/provider-policy-import.mjs!",
  "scripts/perf/sandbox-setup-waits-measure.ts!",
  "scripts/perf/session-actor-participant-hydration-measure.ts!",
  "scripts/perf/session-lifecycle-finish-measure.ts!",
  "scripts/perf/session-row-retention-measure.ts!",
  "scripts/perf/session-snapshot-measure.ts!",
  "scripts/perf/session-source-preparation.ts!",
  "scripts/perf/sqlite-worker-dispatch-measure.ts!",
  "scripts/perf/team-shape-module-census-preload.mjs!",
  "scripts/perf/tool-schema-request-admission-measure.ts!",
  "scripts/perf/trajectory-runtime-append.ts!",
  "scripts/perf/visitor-welcome-lookup-measure.ts!",
  "scripts/perf/worker-operation-registry-measure.ts!",
  "scripts/perf/worker-task-transfer-list-measure.mjs!",
  // The dynamic-consumer compiler follows the computed child launches of these command roots.
  "scripts/perf/archive-worker-churn-measure.ts!",
  "scripts/perf/session-create-measure.ts!",
  "scripts/perf/session-create-repository-measure.ts!",
  // Maintained source headers invoke these standalone commands and external preload by exact path.
  "scripts/bench-control-ui-talk.ts!",
  "scripts/perf/agent-catalog-display-measure.ts!",
  "scripts/perf/agent-event-routing-measure.ts!",
  "scripts/perf/archive-record-framing-measure.mjs!",
  "scripts/perf/board-grid-measure.ts!",
  "scripts/perf/bootstrap-import-preload.mjs!",
  "scripts/perf/branch-summary-identity-measure.ts!",
  "scripts/perf/session-branches-cache-measure.ts!",
  "scripts/perf/catalog-static-preparation-measure.ts!",
  "scripts/perf/channel-presence-suppression.ts!",
  "scripts/perf/config-guard-startup-measure.ts!",
  "scripts/perf/connect-device-identity-measure.ts!",
  "scripts/perf/connect-link-readers-measure.ts!",
  "scripts/perf/core-object-copy-measure.ts!",
  "scripts/perf/core-quadratic-scans-measure.ts!",
  "scripts/perf/diff-baseline-measure.ts!",
  "scripts/perf/exec-approvals-measure.ts!",
  "scripts/perf/gateway-object-copies-measure.mjs!",
  "scripts/perf/git-buffer-capture-measure.ts!",
  "scripts/perf/guarded-body-stream-measure.ts!",
  "scripts/perf/first-stream-event-timeout-measure.ts!",
  "scripts/perf/msteams-json-clone-measure.ts!",
  "scripts/perf/plugin-object-copy-measure.ts!",
  "scripts/perf/plugin-recovery-transport-measure.ts!",
  "scripts/perf/plugin-startup-install-records.ts!",
  "scripts/perf/plugin-metadata-read-measure.ts!",
  "scripts/perf/plugins-list-measure.ts!",
  "scripts/perf/plugins-list-owner-measure.ts!",
  "scripts/perf/provider-prompt-worker-bytes-measure.mjs!",
  "scripts/perf/regexp-pass-deletion-measure.ts!",
  "scripts/perf/session-actor-projection-measure.ts!",
  "scripts/perf/session-entry-patch-payload.ts!",
  "scripts/perf/session-event-envelope-measure.ts!",
  "scripts/perf/session-transcript-path-measure.ts!",
  "scripts/perf/skill-search-copies-measure.ts!",
  "scripts/perf/skill-snapshot-hydration-measure.ts!",
  "scripts/perf/skill-collision-diagnostics-measure.ts!",
  "scripts/perf/sqlite-worker-reply-measure.ts!",
  "scripts/perf/startup-model-scope-measure.ts!",
  "scripts/perf/state-read-metadata-bench.ts!",
  "scripts/perf/state-read-session-list-bench.ts!",
  "scripts/perf/state-read-worker-bench.ts!",
  "scripts/perf/stream-idle-watchdog.ts!",
  "scripts/perf/typing-timer-churn.ts!",
  "scripts/perf/tool-call-stream-buffer-measure.ts!",
  "scripts/perf/tool-source-reply-completion-measure.mjs!",
  "scripts/perf/transcript-model-context-measure.ts!",
  "scripts/perf/ws-event-metrics-measure.ts!",
  // Maintained source headers invoke these standalone analysis commands by exact path.
  "scripts/bench-inbound-metadata-stream.mts!",
  "scripts/perf/avatar-inline-measure.ts!",
  "scripts/perf/codex-catalog-page-decode.ts!",
  "scripts/perf/compaction-serialization-measure.mjs!",
  "scripts/perf/exec-policy-sort-measure.mjs!",
  "scripts/perf/mcp-acquisition-measure.ts!",
  "scripts/perf/profile-avatar-retention-measure.ts!",
  "scripts/perf/shell-extract-bench.ts!",
  "scripts/perf/subagent-active-read-measure.ts!",
  "scripts/perf/subagent-descendant-count-measure.ts!",
  "scripts/perf/subagent-liveness-measure.ts!",
  "scripts/perf/trusted-snapshot-freeze-measure.mjs!",
  "scripts/perf/session-skill-snapshot-intern.ts!",
  "scripts/perf/session-skill-snapshot-intern.preload.mjs!",
  "scripts/perf/git-read-sharing-measure.ts!",
  "scripts/perf/worktree-git-config-measure.ts!",
  // Live proof and test owners spawn or preload these children through computed paths.
  "scripts/perf/bench-ingress-bridge.mjs!",
  "scripts/perf/child-memory-fixture.cjs!",
  "scripts/perf/fsync-tts-worker-preload.mjs!",
  "scripts/perf/session-cost-ready-bridge.mjs!",
  "scripts/perf/session-cost-ready-observer.cjs!",
  "scripts/perf/session-polling-fixture.ts!",
  "scripts/perf/sqlite-reply-census-preload.mjs!",
  "scripts/perf/timer-census-preload.mjs!",
  "scripts/perf/worker-retained-heap-preload.ts!",
  // These retained proof commands are invoked by
  // their source headers, scripts/perf/README.md, and native-allocation-profile.md.
  "scripts/perf/archive-worker-retention-measure.ts!",
  "scripts/perf/codex-catalog-preview-retention.ts!",
  "scripts/perf/config-validate-measure.mjs!",
  "scripts/perf/native-allocation-profile.mjs!",
  "scripts/perf/session-initial-context-fixture.ts!",
  "scripts/perf/session-initial-context-measure.ts!",
  "scripts/perf/session-reload-measure.ts!",
  "scripts/perf/sql-probe-measure.ts!",
  "scripts/perf/workspace-manifest-retention.ts!",
  // Maintained guides and source headers invoke these focused workloads by exact path.
  "scripts/bench-memory-publication.mjs!",
  "scripts/perf/bash-parser-memory.ts!",
  "scripts/perf/chat-progress-capture-measure.ts!",
  "scripts/perf/code-mode-json-fit-measure.ts!",
  "scripts/perf/code-mode-json-gateway-measure.ts!",
  "scripts/perf/crabbox-state-polling.mts!",
  "scripts/perf/local-workspace-manifest-equivalence.ts!",
  "scripts/perf/local-workspace-manifest-measure.ts!",
  "scripts/perf/local-workspace-lookup-measure.ts!",
  "scripts/perf/operator-model-policy-list-probe.mjs!",
  "scripts/perf/operator-model-policy-load.mjs!",
  "scripts/perf/operator-model-policy-measure.ts!",
  "scripts/perf/provider-rate-limit-retention.ts!",
  "scripts/perf/provider-rate-limit-stream-measure.ts!",
  "scripts/perf/provider-error-projection-measure.mjs!",
  "scripts/perf/session-cost-refresh-measure.ts!",
  "scripts/perf/sqlite-operation-receive-measure.ts!",
  "scripts/perf/tool-search-lexical-measure.ts!",
  "scripts/perf/worker-cold-fixture.ts!",
  // The performance drivers load these instrumentation preloads by exact path.
  "scripts/perf/bash-parser-gateway-preload.mjs!",
  "scripts/perf/provider-rate-limit-stress-probe.mjs!",
  "scripts/perf/worker-creation-preload.mjs!",
  // Merged benchmark PRs and source headers invoke these retained workloads by exact path.
  // The transcript broadcast benchmark loads the stall recorder through --gateway-preload.
  "scripts/bench-filesystem-preconditions.mts!",
  "scripts/perf/github-tool-selection-measure.ts!",
  "scripts/perf/github-preview-authority-measure.ts!",
  "scripts/perf/github-conditional-json-measure.ts!",
  "scripts/perf/session-transcript-code-measure.mjs!",
  "scripts/perf/stall-recorder-cost-preload.mjs!",
  "scripts/perf/trajectory-preparation-retention.ts!",
  "scripts/perf/usage-cache-write-measure.ts!",
  "scripts/perf/transcript-session-list-measure.ts!",
  "scripts/perf/transport-pull-allocation-measure.mjs!",
  // Source headers and maintained benchmark contributions invoke these workloads by exact path.
  "scripts/bench-binding-mismatch.mts!",
  "scripts/bench-cron-run.mts!",
  "scripts/bench-delivery-recovery.mts!",
  "scripts/bench-reload-lease.mts!",
  "scripts/bench-team-reports-snapshots.mts!",
  "scripts/perf/async-work-scope-measure.ts!",
  "scripts/perf/local-workspace-callers-measure.ts!",
  "scripts/perf/local-workspace-checkpoint-measure.ts!",
  "scripts/perf/local-workspace-retention.ts!",
  "scripts/perf/plugin-iterator-membrane-measure.ts!",
  "scripts/perf/plugin-generation-retention.ts!",
  "scripts/perf/placement-startup-wake-measure.ts!",
  "scripts/perf/startup-agent-preparation-measure.ts!",
  "scripts/perf/startup-recovery-admission-measure.ts!",
  "scripts/perf/response-decode-measure.mts!",
  "scripts/perf/text-projection-append-measure.ts!",
  "scripts/perf/text-projection-rope-measure.mjs!",
  "scripts/perf/trajectory-persistence.ts!",
  // The maintained drivers spawn or preload these children through exact computed paths.
  "scripts/perf/delivery-recovery-fixture.ts!",
  "scripts/perf/team-reports-snapshots-preload.mjs!",
  "scripts/perf/trajectory-flush-preload.mts!",
  // scripts/perf/README.md invokes this lazy-import probe and its preload by path.
  "scripts/perf/lazy-import-feature-probe.mjs!",
  "scripts/perf/lazy-import-trace-preload.mjs!",
  // Maintainers invoke this isolated transcript-rewrite benchmark by path.
  "scripts/bench-session-manager-rewrite.ts",
  // The team-shaped fixture README invokes these measurement CLIs by path.
  "scripts/perf/team-shape-stress.ts",
  "scripts/perf/team-shape-measure.ts",
  "scripts/perf/transcript-broadcast-measure.ts",
  "scripts/perf/post-restart-burst-measure.ts",
  "scripts/perf/catalog-polling-measure.ts",
  // The history/diff benchmark guide invokes this measurement CLI by path.
  "scripts/perf/history-diff-measure.ts!",
  // scripts/perf/README.md invokes this checkout-diff measurement CLI by path.
  "scripts/perf/checkout-diff-measure.ts!",
  // scripts/perf/README.md invokes this isolated viewer-presence measurement CLI.
  "scripts/perf/presence-churn-measure.ts!",
  // scripts/perf/README.md invokes this isolated session-roster measurement CLI.
  "scripts/perf/session-roster-churn-measure.ts!",
  "scripts/perf/seal-version-restart.ts!",
  // #178599 documents: node --expose-gc scripts/perf/heap-headroom.ts.
  "scripts/perf/heap-headroom.ts!",
  // Maintainers invoke this isolated Doctor metadata-retention benchmark by path.
  "scripts/perf/doctor-metadata-retention.ts!",
  // Maintainers invoke the factory settlement benchmark by path; usage is in its header.
  "scripts/perf/context-engine-factory-retention.ts!",
  // The connected-idle benchmark runs by path and loads its instrumentation with --import.
  "scripts/perf/idle-gateway-measure.ts!",
  "scripts/perf/idle-gateway-measure-preload.mjs!",
  // Worker-environment shutdown proof invokes this measurement CLI by path.
  "scripts/perf/worker-environment-shutdown-measure.ts!",
  // The branch-rotation guide invokes the driver, which loads its IPC preload by path.
  "scripts/perf/branch-rotation-measure.ts!",
  "scripts/perf/branch-rotation-measure-preload.ts!",
  // The plugin scope census is loaded by the documented stress --gateway-preload option.
  "scripts/perf/plugin-scope-attribution-preload.mjs!",
  // The documented placement shutdown reproduction is invoked as a standalone CLI.
  "scripts/perf/worker-placement-reconcile-shutdown-measure.ts!",
  // Their headers document these standalone measurement CLIs by path.
  "scripts/perf/agent-db-inspection-close-measure.mjs!",
  "scripts/perf/agent-prepare-write-measure.mjs!",
  "scripts/perf/config-health-restart-measure.ts!",
  "scripts/perf/connect-tail-measure.ts!",
  "scripts/perf/device-token-snapshot-measure.ts!",
  "scripts/perf/paired-row-encoding-measure.ts!",
  "scripts/perf/session-patch-projection-measure.ts!",
  "scripts/perf/session-actor-writer-append-measure.ts!",
  "scripts/perf/session-cost-usage-cold-read.ts!",
  "scripts/perf/worker-warm-floor-measure.mjs!",
  "scripts/perf/worktree-branches-measure.ts!",
  // connect-tail-measure.ts loads this diagnostics preload through --gateway-preload.
  "scripts/perf/connect-tail-preload.mjs!",
  // The standalone build guide invokes this builder by path.
  "scripts/build-bun-standalone.mjs!",
  // Maintainers invoke the isolated macOS standalone Doctor proof by path.
  "scripts/verify-standalone-doctor.mjs!",
  "scripts/build-discord-activity-sdk.mts!",
  // Plugin package asset hooks invoke the browser builder by path.
  "scripts/build-plugin-control-ui.mts!",
  // package-mac-app.sh launches the architecture scheduler by path.
  "scripts/build-mac-swift.mts!",
  // CI passes this native test launcher through the Apple command log wrapper.
  "scripts/test-macos-native.mts!",
  "scripts/check-control-ui-performance.mts!",
  "scripts/check-control-ui-precompressed-assets.mts!",
  "scripts/check-package-dist-imports.mjs!",
  "scripts/check-plugin-sdk-exports.mts!",
  // Declaration preparation and boundary checks launch this compiler worker by path.
  "scripts/compile-extension-boundary.mts!",
  // openclaw-performance.yml invokes the paired benchmark CLI by path.
  "scripts/vitest-pair-benchmark.mts!",
  // Cloudflare deployment template: wrangler bundles the Worker from this entry.
  "scripts/cloudflare/src/index.ts!",
  // Invoked by the documented Gateway and macOS Computer Use live-proof commands.
  "scripts/dev/computer-use-gateway-live-proof.ts!",
  "scripts/dev/computer-use-macos-live-proof.ts!",
  "scripts/dev/ios-node-e2e.ts!",
  "scripts/diffs-shiki-curated.ts!",
  // The Doctor migration guide invokes this source-checkout replay by path.
  "scripts/doctor-config-upgrade-replay.mjs!",
  // Reusable Docker workflows invoke this from the downloaded .release-harness tree.
  "scripts/docker-e2e.mts!",
  // Its inline Node bootstrap imports the shared watchdog by a shell-computed path.
  "scripts/lib/docker-e2e-container.sh!",
  // Docker and package-install harnesses invoke this verifier by path.
  "scripts/docker/verify-fs-safe-native.mjs!",
  // Docker runtime-assets assembles package-declared bootstrap files through this CLI.
  "scripts/docker/copy-bootstrap-scripts.mjs!",
  // Reusable Docker workflows invoke this selector from a trusted sparse checkout.
  "scripts/resolve-fs-safe-native-contract.mjs!",
  // The live Docker launcher executes this runner by path inside the package image.
  "scripts/e2e/anthropic-cache-live.mts!",
  "scripts/e2e/lib/browser-cdp-snapshot/assert-snapshot.mjs!",
  "scripts/e2e/lib/browser-cdp-snapshot/fixture-server.mjs!",
  // The Bun-only smoke runs this harness by path and loads the preload through BUN_OPTIONS.
  "scripts/e2e/lib/bun-only-runtime/harness.mjs!",
  "scripts/e2e/lib/bun-only-runtime/spawn-trace-preload.mjs!",
  "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs!",
  "scripts/e2e/lib/clawhub-fixture-server.cjs!",
  "scripts/e2e/lib/codex-media-path/client.mjs!",
  "scripts/e2e/lib/codex-media-path/fake-codex-app-server.mjs!",
  "scripts/e2e/lib/codex-media-path/write-config.mjs!",
  "scripts/e2e/lib/codex-npm-plugin-live/followthrough-turn.mjs!",
  "scripts/e2e/lib/codex-on-demand/doctor-checks.mjs!",
  "scripts/e2e/lib/config-reload/assert-log.mjs!",
  "scripts/e2e/lib/config-reload/mutate-metadata.mjs!",
  "scripts/e2e/lib/container-image-upgrade/assert-launch.mjs!",
  "scripts/e2e/lib/container-image-upgrade/fixture.mjs!",
  "scripts/e2e/lib/docker-artifact-proof/write-identities.ts!",
  "scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs!",
  "scripts/e2e/lib/doctor-install-switch/assert-exec-start.mjs!",
  "scripts/e2e/lib/doctor-install-switch/write-wrapper.mjs!",
  // Historical upgrade shells and the cross-OS adapter execute this assertion CLI.
  "scripts/e2e/lib/external-package-transition.mjs!",
  "scripts/e2e/lib/fixture.mjs!",
  "scripts/e2e/lib/fixtures/config.mjs!",
  "scripts/e2e/lib/fixtures/plugins.mjs!",
  "scripts/e2e/lib/fixtures/workspace.mjs!",
  // The Docker custody shell copies the server and mounts the scenario by path.
  "scripts/e2e/lib/mcp-docker-custody/scenario.mjs!",
  "scripts/e2e/lib/mcp-docker-custody/server.cjs!",
  // Muse Docker shells invoke auth directly and select deterministic/consent/live by mode.
  "scripts/e2e/lib/muse-runtime/auth.mjs!",
  "scripts/e2e/lib/muse-runtime/consent.mjs!",
  "scripts/e2e/lib/muse-runtime/deterministic.mjs!",
  "scripts/e2e/lib/muse-runtime/live.mjs!",
  // test:e2e:node-auto-update runs the installed-package proof against a frozen tarball.
  "scripts/e2e/lib/node-auto-update/scenario.mjs!",
  // Installed-package authority proof runs by path and injects its worker preload via NODE_OPTIONS.
  "scripts/e2e/lib/paired-node-skills-authority/scenario.mjs!",
  "scripts/e2e/lib/paired-node-skills-authority/pause-worker.mjs!",
  "scripts/e2e/lib/npm-telegram-live/prepare-package.mts!",
  "scripts/e2e/lib/onboard/assert-config.mjs!",
  "scripts/e2e/lib/onboard/write-config.mjs!",
  "scripts/e2e/lib/openai-chat-tools/client.mjs!",
  "scripts/e2e/lib/openai-chat-tools/cold-recall.mjs!",
  "scripts/e2e/lib/openai-chat-tools/write-config.mjs!",
  "scripts/e2e/lib/package-git-fixture.mjs!",
  "scripts/e2e/lib/plugin-lifecycle-matrix/measure.mjs!",
  "scripts/e2e/lib/plugin-update/registry-server.mjs!",
  "scripts/e2e/lib/plugins/npm-registry-server.mjs!",
  "scripts/e2e/lib/release-plugin-marketplace/lifecycle-assertions.mjs!",
  "scripts/e2e/lib/release-scenarios/write-cli-plugin.mjs!",
  "scripts/e2e/lib/release-scenarios/write-marketplace.mjs!",
  "scripts/e2e/lib/release-user-journey/clickclack-fixture.mjs!",
  "scripts/e2e/lib/release-user-journey/write-clickclack-plugin.mjs!",
  "scripts/e2e/lib/run-with-pty.mjs!",
  "scripts/e2e/lib/sandbox-browser-sidecar/scenario.mjs!",
  "scripts/e2e/lib/session-cold-storage/client.mjs!",
  // abandoned-update.sh invokes the upgrade ledger assertions through Node.
  "scripts/e2e/lib/upgrade-survivor/abandoned-update.mjs!",
  // backup-rollback.sh invokes capture and verification through this CLI.
  "scripts/e2e/lib/upgrade-survivor/backup-rollback.mjs!",
  // run.sh invokes the backup schedule upgrade scenario through this CLI.
  "scripts/e2e/lib/upgrade-survivor/backup-schedule.mjs!",
  "scripts/e2e/lib/upgrade-survivor/channel-owner-policy.mjs!",
  "scripts/e2e/lib/upgrade-survivor/config-parking.mjs!",
  // run.sh invokes this CLI and preloads it into updater/Doctor children.
  "scripts/e2e/lib/upgrade-survivor/cron-owner-doctor.mjs!",
  "scripts/e2e/lib/upgrade-survivor/custom-plugin-siblings.mjs!",
  // Capture runs in the container; sanitization runs only on the trusted host.
  "scripts/e2e/lib/upgrade-survivor/diagnostics.mjs!",
  "scripts/upgrade-survivor-diagnostics.mjs!",
  // run.sh invokes this CLI and preloads it into updater/Doctor children.
  "scripts/e2e/lib/upgrade-survivor/dreaming-cron.mjs!",
  "scripts/e2e/lib/upgrade-survivor/formerly-bundled-plugin-doctor.mjs!",
  "scripts/e2e/lib/upgrade-survivor/legacy-operator-restored-index.mjs!",
  "scripts/e2e/lib/upgrade-survivor/missing-configured-plugin-migration.mjs!",
  // run.sh starts this persistent native peer as a separate process.
  "scripts/e2e/lib/upgrade-survivor/native-assignment-app-server.mjs!",
  // package-activation-recovery.sh preloads this observer into the released updater.
  "scripts/e2e/lib/upgrade-survivor/package-activation-fault.mjs!",
  // run.sh preloads this fixture adapter through NODE_OPTIONS by path.
  "scripts/e2e/lib/upgrade-survivor/plugin-registry-redirect.mjs!",
  "scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs!",
  "scripts/e2e/lib/upgrade-survivor/probe-volume-gateway.mjs!",
  "scripts/e2e/lib/upgrade-survivor/projects-doctor.mjs!",
  // published-driver-update-docker.sh launches this managed-update proof inside Docker.
  "scripts/e2e/lib/upgrade-survivor/published-driver.mjs!",
  "scripts/e2e/lib/upgrade-survivor/published-plugin-registry.mjs!",
  "scripts/e2e/lib/upgrade-survivor/recovery-cleanup.mjs!",
  // The compiler below exposes the runner's inline Node imports.
  "scripts/e2e/lib/upgrade-survivor/run.sh!",
  "scripts/e2e/lib/upgrade-survivor/schema-expectation.mjs!",
  // The upgrade-survivor runner invokes the session-share baseline and checks by path.
  "scripts/e2e/lib/upgrade-survivor/session-share.mjs!",
  // update-restart-auth.sh installs this manager/launch adapter into the fixture bin directory.
  "scripts/e2e/lib/upgrade-survivor/systemd-fixture.mjs!",
  // The first-hop shell executes the packaged admission entry probe by path.
  "scripts/e2e/lib/upgrade-survivor/update-admission-entry-probe.mjs!",
  "scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs!",
  "scripts/e2e/lib/upgrade-survivor/update-report-recovery.mjs!",
  // run.sh wraps the legacy operator-state updater with this timeout observer.
  "scripts/e2e/lib/upgrade-survivor/update-timeout-diagnostics.mjs!",
  "scripts/e2e/lib/upgrade-survivor/mobile-pairing-client.mts!",
  "scripts/e2e/lib/upgrade-survivor/watchos-direct-node.mjs!",
  "scripts/embedded-run-abort-leak.ts!",
  "scripts/embedded-run-liveness-leak.ts!",
  "scripts/fixtures/packed-plugin-sdk-type-smoke.ts!",
  // Generates the native browser page scripts from their UI source modules.
  "scripts/generate-browser-inspect-script-swift.mts!",
  // db:postgres:gen and db:postgres:check invoke the canonical schema generator by path.
  "scripts/generate-postgres-schema.mts!",
  // The diagnostics guide invokes the sustained Gateway heap rig by path.
  "scripts/gateway-heap-rig.mjs!",
  // The diagnostics guide invokes this offline snapshot comparison CLI by path.
  "scripts/heap-snapshot-diff.mjs!",
  // CI executes screenshot evidence from the workflow-owned harness copy.
  "scripts/ios-screenshot-evidence.mjs!",
  "scripts/ios-release-cut.ts!",
  "scripts/ios-release-plan.ts!",
  // Android Fastlane invokes this planner and its pre-upload validation by path.
  "scripts/android-release-plan.ts!",
  "scripts/ios-release-signing.mts!",
  "scripts/lib/docker-plugin-selection.mjs!",
  // The frozen compatibility shell invokes the source CLI and imports trusted tooling.
  "scripts/lib/frozen-target-source.mjs!",
  "scripts/lib/frozen-target-compat.sh!",
  // CI loads the native Vitest reporter through its CLI path.
  "scripts/lib/vitest-resource-reporter.mts!",
  // Invoked by scripts/lib/live-docker-stage.sh during container validation.
  "scripts/live-docker-normalize-config.ts!",
  // Mantis controllers launch these observers and bridge by path inside isolated runtimes.
  "scripts/mantis/observe-request-telegram-qa.mts!",
  "scripts/mantis/observe-request-web-ui.mts!",
  "scripts/mantis/telegram-proof-bridge.mjs!",
  "scripts/mcp-code-mode-gateway-e2e.ts!",
  // The MCP Events live driver and fixture README launch this developer CLI by path.
  "scripts/mcp-events-test-server.mjs",
  // Immutable systemd installations invoke the packaged launcher by path.
  "scripts/openclaw-immutable-launcher.mjs!",
  // Existing explicit Linux proof driver imports the inactive capsule adapter.
  // Reachability for auditing is not registration or permission to execute it.
  "scripts/openclaw-release-clawhub-plan.ts!",
  "scripts/openclaw-release-clawhub-runtime-state.ts!",
  // Protected preparation/button workflows invoke this coordinator by path.
  "scripts/openclaw-release-ready.mjs!",
  // Oxlint loads this JS plugin by path from config/oxlint/boundary-guards.json.
  "scripts/oxlint-boundary-guards.mjs!",
  "scripts/plugin-prerelease-liveish-matrix.mts!",
  "scripts/pre-commit/guard-staged-content.mjs!",
  // Frozen-target contract admission is invoked as a standalone Node CLI.
  "scripts/preflight-frozen-target-contracts.mjs!",
  // #175328 invokes this real agent-exec streaming proof by path.
  "scripts/proof-final-answer-stream.mts!",
  // Generates the checked-in native protocol models from core descriptor metadata.
  "scripts/protocol-gen.ts!",
  "scripts/pr-lib/ci-dispatch.mjs!",
  // review.sh invokes the corrected-candidate review validator by path.
  "scripts/pr-lib/correction-review.mjs!",
  // prepare-core.sh invokes correction continuation and recovery by path.
  "scripts/pr-lib/correction-continuation.mjs!",
  "scripts/pr-lib/gh-api-preflight.mjs!",
  "scripts/pr-lib/materialize-dependencies.mjs!",
  "scripts/pr-lib/merge-body.mjs!",
  // merge.sh executes legacy capture qualification as a standalone Node CLI.
  "scripts/pr-lib/merge-legacy-refusal.mjs!",
  // merge.sh and merge-outcome.sh execute refusal qualification by path.
  "scripts/pr-lib/merge-pre-dispatch-refusal.mjs!",
  // merge.sh verifies prior exact-head CI evidence through this CLI by path.
  "scripts/pr-lib/merge-prior-ci.mjs!",
  // merge-outcome.sh launches the REST adapter as a standalone Node CLI.
  "scripts/pr-lib/merge-rest.mjs!",
  "scripts/pr-lib/review-artifacts.mjs!",
  // worktree.sh invokes this journal-state validator by path before native replay.
  "scripts/pr-lib/review-transition-state.mjs!",
  "scripts/pr-lib/process-group-runner.mjs!",
  // worktree.sh launches the locked cold-worktree adapter by path.
  "scripts/pr-lib/worktree-provision.mts!",
  "scripts/pre-commit/filter-staged-files.mjs!",
  "scripts/print-live-docker-plugin-selection.mjs!",
  "scripts/qa-coverage-report.ts!",
  "scripts/qa-parity-report.ts!",
  // qa/README.md delegates campaign Git execution to this guarded CLI by path.
  "scripts/qa/repository-checkpoint-admission.ts!",
  // Docker/release workflows launch the warning relay from copied harness roots.
  "scripts/relay-build-limit-warnings.mts",
  "scripts/resolve-frozen-codex-live-suite.mjs!",
  // Changed-file checks invoke this targeted UI Stylelint entrypoint by path.
  "scripts/run-stylelint.mts!",
  // lint-swift.sh launches the SwiftLint policy wrapper by absolute path.
  "scripts/run-swiftlint.mts",
  // Path-spawned test roots are development entries; `!` would audit dev tools as production.
  "scripts/run-vitest-child.mts",
  // The isolated Vitest adapter executes this entry by path inside its container.
  "scripts/lib/vitest-isolated-entry.mts",
  "scripts/secrets/openclaw-bws-resolver.mjs!",
  // Security Review stages these entrypoints from isolated checkout attempts.
  "scripts/github/security-review-event.mjs!",
  "scripts/github/security-review.mjs!",
  "scripts/sync-labels.ts!",
  "scripts/test-built-bundled-channel-entry-smoke.mts!",
  // The artifact producer invokes this shared test compiler owner by path.
  "scripts/test-built-source-verifiers.mts",
  // CI launches the desktop resize proof through its bootstrap path.
  "scripts/test-desktop-resize-real.mts!",
  // Native shell UI tests connect to this manually launched loopback Gateway fixture.
  "scripts/test-ios-shell-gateway.mjs!",
  "scripts/test-ios-sidebar-attention-gateway.mjs!",
  "scripts/update-clawtributors.ts!",
  // The candidate binder invokes this trusted producer-identity verifier by path.
  "scripts/verify-full-release-producer-job.mjs!",
  // Staging and signed-app packaging execute this verifier with each bundled Bun.
  "scripts/verify-mac-runtime.mjs!",
  // App packaging verifies reusable source artifacts before preserving their build identity.
  "scripts/verify-mac-source-build.mts!",
  "scripts/verify-stable-main-closeout.mjs!",
  "scripts/write-package-dist-inventory.ts!",
  "scripts/write-plugin-sdk-entry-dts.ts!",
  "scripts/write-unified-entry-dts.ts!",
  "security/opengrep/check-rule-metadata.mjs!",
  "security/opengrep/compile-rules.mjs!",
  // create-claw/SKILL.md invokes this CLI bridge for skills and plugin inventory.
  "skills/create-claw/scripts/cli.mjs!",
  "skills/meme-maker/scripts/meme.mjs!",
] as const;

// Compatibility shims are executable roots and load their typed implementations by computed URL,
// which Knip cannot follow in either direction.
function listScriptShimEntries(dir = "scripts"): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listScriptShimEntries(entryPath);
    }
    if (!entry.isFile() || (!entry.name.endsWith(".mjs") && !entry.name.endsWith(".js"))) {
      return [];
    }
    const implementationPath = entryPath.replace(/\.(?:mjs|js)$/u, ".mts");
    return fs.existsSync(implementationPath)
      ? [entryPath, implementationPath].map((filePath) => `${filePath.replaceAll("\\", "/")}!`)
      : [];
  });
}

function compileWorkflowConsumers(source: string, filePath: string): string {
  if (path.resolve(filePath) === path.resolve(".github/workflows/openclaw-release-publish.yml")) {
    return [
      ...source.matchAll(
        /\bimport\s*\{([^}]+)\}\s*from\s*["']\.\/\.release-harness\/(scripts\/[^"'\r\n]+)["']/gu,
      ),
    ]
      .map(
        ([, names, specifier]) => `import {${names}} from ${JSON.stringify(`../../${specifier}`)};`,
      )
      .join("\n");
  }
  if (path.resolve(filePath) === path.resolve(".github/workflows/labeler.yml")) {
    return [
      ...new Set(
        [
          ...source.matchAll(
            /\bconst\s*\{([^}]+)\}\s*=\s*await\s+import\(\s*pathToFileURL\(`\$\{process\.env\.GITHUB_WORKSPACE\}\/(scripts\/[^`\r\n]+)`\)\.href\s*\)/gu,
          ),
        ].map(
          ([, names, specifier]) =>
            `import {${names}} from ${JSON.stringify(`../../${specifier}`)};`,
        ),
      ),
    ].join("\n");
  }
  if (path.resolve(filePath) !== path.resolve(".github/workflows/plugin-prerelease.yml")) {
    return "";
  }
  const names = new Set(
    [
      ...source.matchAll(
        /\b(?:import|const)\s*\{([^}]+)\}\s*(?:from\s*|=\s*await\s+import\()["']\.\/\.frv-tooling\/scripts\/frv-test-exclusions\.mjs["']/gu,
      ),
    ].flatMap((match) => match[1]?.split(",").map((name) => name.trim()) ?? []),
  );
  // The run CLI writes a Vitest config importing its own URL. Model that emitted
  // import only while the workflow invokes the generator, and derive its names
  // from the real template so removing a consumer restores the unused finding.
  if (/\.frv-tooling\/scripts\/frv-test-exclusions\.mjs["']?,?\s+["']?run["']?/u.test(source)) {
    const generator = fs.readFileSync("scripts/frv-test-exclusions.mjs", "utf8");
    for (const match of generator.matchAll(
      /`import\s*\{([^}]+)\}\s*from\s*\$\{JSON\.stringify\(import\.meta\.url\)\};`/gu,
    )) {
      for (const name of match[1]?.split(",") ?? []) {
        names.add(name.trim());
      }
    }
  }
  return names.size
    ? `import { ${[...names].join(", ")} } from "../../scripts/frv-test-exclusions.mjs";`
    : "";
}

function compileShellConsumers(source: string, filePath: string): string {
  if (path.resolve(filePath) === path.resolve("scripts/lib/docker-e2e-container.sh")) {
    const helper = source.match(
      /local helper_source="\$DOCKER_E2E_CONTAINER_LIB_DIR\/([^"\r\n]+\.mjs)"/u,
    )?.[1];
    const names = source.match(
      /\bconst\s*\{([^}]+)\}\s*=\s*await\s+import\(pathToFileURL\(\\?"\$helper_source\\?"\)\.href\)/u,
    )?.[1];
    return helper && names ? `import {${names}} from ${JSON.stringify(`./${helper}`)};` : "";
  }
  if (path.resolve(filePath) === path.resolve("scripts/lib/frozen-target-compat.sh")) {
    // These URLs resolve beside this shell file; keep the export edges tied to its actual imports.
    return [
      ...source.matchAll(
        /\bconst\s*\{([^}]+)\}\s*=\s*await\s+import\(new URL\("(\.\/[^"\r\n]+\.mjs)", pathToFileURL\(trustedHelper\)\)\)/gu,
      ),
    ]
      .map(([, names, specifier]) => `import {${names}} from ${JSON.stringify(specifier)};`)
      .join("\n");
  }
  if (path.resolve(filePath) !== path.resolve("scripts/e2e/lib/upgrade-survivor/run.sh")) {
    return "";
  }
  const imports = source.match(
    /^[ \t]*import\s*\{[^}]+\}\s*from\s*["']\.\/scripts\/[^"'\r\n]+["'];?/gmu,
  );
  return (imports ?? [])
    .map((declaration) =>
      declaration.replace(/["'](\.\/scripts\/[^"']+)["']/u, (_match, specifier: string) => {
        const relative = path
          .relative(path.dirname(filePath), path.resolve(specifier))
          .replaceAll("\\", "/");
        return JSON.stringify(relative.startsWith(".") ? relative : `./${relative}`);
      }),
    )
    .join("\n");
}

const rootEntries = [
  ...repositoryScriptEntries,
  ...listScriptShimEntries(),
  // Runtime launchers resolve these by URL rather than a static import edge.
  ...[
    ...Object.values(runtimeProcessBuildEntries),
    ...createManagedHandoffBuildConfigs().flatMap(({ entry }) => Object.values(entry)),
  ].map((source) => `${path.relative(".", source).replaceAll("\\", "/")}!`),
  // The runtime manifest also declares generated script sources/outputs and source-only tooling.
  ...collectRuntimeProcessManifestEntries(
    runtimeProcessScriptEntrypoints,
    runtimeProcessToolingEntrypoints,
  ).map((source) => `${source}!`),
  // Knip loads these audit configurations directly by command-line path.
  "config/knip.config.ts!",
  "config/knip.all-exports.config.ts!",
  "config/knip.scripts-exports.config.ts!",
  "config/knip-dynamic-consumers.mjs!",
  // tsdown consumes the runtime-process manifests while constructing portable worker builds.
  "tsdown.config.ts!",
  // OpenGrep rule tests read these as static source inputs; they are never executed.
  "security/opengrep/rules/*/*.{js,ts}!",
  "{openclaw,docker-entrypoint}.mjs!",
  // Desktop service integration consumes this API in the staged builder/app cutover (#172569).
  // Remove this audit root after those in-tree callers land.
  "cli-invocation.mjs!",
  // update-command-node-runtime-resolution loads this package-root module by absolute URL.
  "node-runtime-recovery.mjs!",
  "src/index.ts!",
  "src/entry.ts!",
  // Inactive phase-owner API for the staged session caller cutover. Remove these
  // audit roots once accept-input, transcript, and delivery callers activate it.
  "src/config/sessions/session-actor-contract.ts!",
  "src/config/sessions/session-actor-durable.ts!",
  // PR #174294 stages the local credential owner without activating production consumers.
  // Remove this audit root when the client credential cutover wires those consumers.
  "src/infra/client-credential-store.ts!",
  // Startup metadata renders source help through a generated child module's file-URL import.
  "src/cli/program/root-help.ts!",
  // Packaged postinstall imports this private compiled entry before stage activation.
  "src/commands/doctor-update-schema-guard.ts!",
  // Built as the official image's Docker HEALTHCHECK entrypoint.
  "src/docker-healthcheck.ts!",
  // Deployed in the worker archive and launched by path, without a static host import.
  "src/worker/worker-deploy-client-credentials.ts!",
  "src/worker/worker-deploy-entry.ts!",
  "src/worker/worker-deploy-file-tool-planning.ts!",
  "src/worker/worker-deploy-file-tool-read.ts!",
  "src/worker/worker-deploy-image-processor.ts!",
  "src/worker/worker-deploy-sqlite-source-revision.ts!",
  "src/worker/worker-deploy-sqlite-store.ts!",
  "src/worker/worker-deploy-state-read.ts!",
  "src/worker/workspace-rsync-receiver.ts!",
  // v2026.9.1 Gateways lazy-import this stable dist entry after an in-place update.
  "src/gateway/plugin-channel-reload-targets.ts!",
  // Published-update bridges import lifecycle facts from this stable dist entry.
  "src/agents/provider-runtime-lifecycle.ts!",
  // July and later Gateways retain this lazy entry across in-place updates.
  "src/agents/models-config.runtime.ts!",
  // Shipped compatibility facade for statusCommand and getStatusSummary.
  "src/commands/status.ts!",
  "src/cli/daemon-cli.ts!",
  "src/agents/code-mode.worker.ts!",
  // Offline port foundations precede orchestration; remove with their first production callers.
  "src/infra/database-engine/port.worker.ts!",
  "src/snapshot/export-envelope.ts!",
  // Worker-thread and script entrypoints import contracts that production Knip cannot trace.
  "src/config/sessions/disk-budget.worker.ts!",
  "scripts/print-cli-backend-live-metadata.ts!",
  // Workflow/package-script entrypoints are not imported from production modules.
  "scripts/openclaw-cross-os-release-checks.ts!",
  "scripts/release-plan-producer-core.mts!",
  "scripts/release-plan-producer.mts!",
  // The producer verifies committed bytes, then launches this module through node -e.
  "scripts/lib/release-plan-child-runner.mjs!",
  "scripts/full-release-publication-observations.mts!",
  "scripts/release-verify-publish.ts!",
  // Spawned by the agent concurrency benchmark; no static import edge exists.
  "scripts/bench-agent-concurrency-worker.ts!",
  "scripts/bench-sqlite-reliability.ts!",
  "scripts/bench-cron-session-reaper.ts!",
  // docs/reference/test/performance.md invokes this standalone comparison harness.
  "scripts/bench-workspace-computation.ts!",
  // packages/worker-runtime/README.md invokes the benchmark; its worker is loaded by URL.
  "scripts/bench-worker-runtime.ts!",
  "scripts/bench-worker-runtime.worker.ts!",
  // docs/help/testing/control-ui-load.md invokes this opt-in Linux process/protocol proof.
  "scripts/bench-gateway-control-ui-proof.ts!",
  // Docker/manual E2E executables and their nested assertion/probe entrypoints.
  "scripts/e2e/*.{js,mjs,ts}!",
  "scripts/e2e/lib/**/{assertions,probe,mock-server}.{js,mjs,ts}!",
  "src/agents/prepared-model-catalog.worker.ts!",
  // Split runtime loaded through a path assembled in subagent-registry.ts.
  "src/agents/subagents/registry/subagent-registry.runtime.ts!",
  // Loaded lazily by the sweeper only when a receipt-bearing or interrupted row is found.
  "src/agents/subagents/registry/subagent-registry-restart-recovery.ts!",
  // Reply dispatch and Gateway startup consume this namespace through loadGetReplyFromConfigRuntime.
  "src/auto-reply/reply/get-reply-from-config.runtime.ts!",
  // Command attempts consume this namespace through runtime-loaders.ts's Promise.all preload.
  "src/agents/command/attempt-execution.runtime.ts!",
  // Human plugin listing lazily loads its formatter to keep JSON startup lean.
  "src/cli/plugins-list-format.ts!",
  "src/infra/warning-filter.ts!",
  // The session extension SDK exposes this type-only declaration owner.
  "src/agents/sessions/extensions/types.ts!",
  // Plugin-SDK ACP facades expose the registry's runtime signatures.
  "src/acp/runtime/registry.ts!",
  "src/plugins/runtime/index.ts!",
  "src/plugins/source-display.ts!",
  "src/mcp/codex-supervision-tools-serve.ts!",
  // Spawned by generated system-agent MCP configs; this stdio entry is not statically imported.
  "src/mcp/openclaw-tools-serve.ts!",
  // Spawned by ACPX and QA Lab from a generated plugin-tool MCP command line.
  "src/mcp/plugin-tools-serve.ts!",
  // Dedicated tsdown entry exercised against built plugin singletons.
  "src/plugins/build-smoke-entry.ts!",
  // Required metadata readers load this tsdown entry by computed source/dist path.
  "src/plugins/plugin-metadata-readers.runtime.ts!",
  "src/commands/doctor/shared/legacy-config-binding-repair.runtime.ts!",
  // Released Gateways still import this stable entry after an on-disk update.
  "src/gateway/plugin-channel-reload-targets.ts!",
  // Package-script owners invoke these generated-artifact modules directly.
  "src/config/doc-baseline.ts!",
  "src/plugins/runtime-sidecar-paths-baseline.ts!",
  // The runtime-script asset generator bundles these sources into checked-in production modules.
  "src/gateway/mcp-app-standalone-host.ts!",
  "src/gateway/worker-environments/repository-node-requirement.ts!",
  "src/shared/keyboard-shortcuts.ts!",
  // Imported by scripts/tsdown-build.mts as the AI package build configuration.
  "tsdown.ai.config.ts!",
  // Maintainer-owned compatibility data referenced by release/docs workflows.
  "src/commands/doctor/shared/deprecation-compat.ts!",
  // Compiled as the package-boundary failure canary by the extension checker.
  "src/plugins/contracts/rootdir-boundary-canary.ts!",
  // Native applications load these JavaScript assets directly rather than through Node imports.
  "apps/android/app/src/main/assets/katex/katex.min.js!",
  "apps/android/app/src/main/assets/katex/renderer.js!",
  "apps/linux/ui/main.js!",
  "apps/linux/ui/quickchat.js!",
  // The native window-chrome owner injects this script through Rust include_str!.
  "apps/linux/ui/window-chrome.js!",
  // The native Gateway auth owner injects this script through Rust include_str!.
  "apps/linux/ui/native-control-auth.js!",
  "apps/linux/ui/gateway-switch.js!",
  "apps/linux/ui/gateway-notice.js!",
  "apps/linux/ui/gateways.js!",
  "scripts/qa/render-maturity-docs.ts!",
  bundledPluginFile("telegram", "src/audit.ts", "!"),
  bundledPluginFile("telegram", "src/token.ts", "!"),
  "src/hooks/bundled/*/handler.ts!",
  // Local-only test-state consumers are modeled by the full-tree test scan.
  "src/plugin-sdk/!(test-state).ts!",
] as const;

const bundledPluginEntries = [
  "index.ts!",
  "setup-entry.ts!",
  // Setup APIs may lazy-load this top-level package artifact by string specifier.
  "setup-surface.ts!",
  // Core resolves these public plugin artifacts by basename rather than by a
  // static import from the plugin entry module.
  "*-api.ts!",
  "cli-metadata.ts!",
  "channel-entry.ts!",
  "configured-state.ts!",
  // Manifest and SDK loaders resolve these public artifacts by basename.
  "auth-presence.ts!",
  "thread-bindings-runtime.ts!",
  "document-extractor.ts!",
  "web-content-extractor.ts!",
  "timeouts.ts!",
  "action-runtime.runtime.ts!",
  "allow-from.ts!",
  // Provider catalogs and web tools resolve these manifest/convention-owned
  // modules from the plugin root at runtime.
  "provider-discovery.ts!",
  "capability-catalog.ts!",
  "{web-search,web-fetch}-provider.ts!",
  "{api,contract-api,helper-api,runtime-api,light-runtime-api,update-offset-runtime-api,channel-plugin-api,provider-plugin-api,setup-api}.ts!",
  "subagent-hooks-api.ts!",
  "src/{api,runtime-api,light-runtime-api,update-offset-runtime-api,channel-plugin-api,provider-plugin-api,doctor-contract,setup-surface,mcp-serve}.ts!",
  "src/subagent-hooks-api.ts!",
] as const;

const bundledPluginIgnoredRuntimeDependencies = [
  "@agentclientprotocol/claude-agent-acp",
  "@azure/identity",
  "@clawdbot/lobster",
  "@discord/embedded-app-sdk",
  "@discordjs/opus",
  "@homebridge/ciao",
  "@matrix-org/matrix-sdk-crypto-wasm",
  "@mozilla/readability",
  "@openai/codex",
  "@pierre/theme",
  "@tloncorp/tlon-skill",
  "@agentclientprotocol/codex-acp",
  "jiti",
  "json5",
  "linkedom",
  "openclaw",
  "clawpdf",
] as const;

const rootBundledPluginRuntimeDependencies = [
  "@anthropic-ai/sdk",
  "@google/genai",
  "@grammyjs/transformer-throttler",
  "@homebridge/ciao",
  "@mozilla/readability",
  "@silvia-odwyer/photon-node",
  "@trycua/cua-driver",
  // Root bundles the browser plugin's patched MCP server for npm installations.
  "chrome-devtools-mcp",
  // Browser and Teams import Express; bundled Browser chunks resolve it from root.
  "express",
  "grammy",
  "linkedom",
  "minimatch",
  "node-edge-tts",
  "clawpdf",
] as const;

// Root installation and build workflows deliberately mirror these dependencies from their
// owning workspace, or invoke their package binaries/loaders without a static module import.
const rootToolingAndWorkspaceDependencies = [
  "@copilotkit/aimock",
  // scripts/ui.mts anchors these lookups at ui/package.json before invoking the UI workspace.
  "@vitest/browser-playwright",
  "dompurify",
  // Root typecheck/test projects compile @openclaw/net-policy source directly.
  // Keep its exact dependency available without externalizing it from packaged builds.
  "ipaddr.js",
  "jscpd",
  // Runtime postbuild resolves this build input from its caller-selected root.
  "marked",
  "oxlint",
  "oxlint-tsgolint",
  // The scripts typecheck compiles UI Vite config against the root Vite dependency.
  "postcss",
  "signal-utils",
  // Root declaration builds compile terminal-core source and resolve this package from root.
  "string-width",
] as const;

function workspacePackage(packageDir: string, extraEntries: readonly string[] = []) {
  const workspace = path.join("packages", packageDir);
  return {
    // Package exports, not shell arguments, own these public source entrypoints.
    entry: [
      ...Object.values(buildPackageDistEntriesFromExports(packageDir)).map(
        (source) => path.relative(workspace, source).replaceAll("\\", "/") + "!",
      ),
      ...extraEntries,
    ],
    project: ["src/**/*.ts!"],
  } as const;
}

function compileDynamicMjsConsumers(source: string, filePath: string): string {
  if (path.resolve(filePath) === path.resolve("config/knip-dynamic-consumers.mjs")) {
    return compileDynamicConsumerEdges(source, filePath, runtimeProcessScriptEntrypoints);
  }
  // A custom TS compiler disables Knip's declaration-to-source mapping.
  if (path.resolve(filePath) === path.resolve("config/knip-vite-consumers.mjs")) {
    return compileViteConfigConsumers(source, filePath);
  }
  if (path.resolve(filePath) === path.resolve("scripts/ci-build-manifest.mjs")) {
    // The trusted manifest resolves this planner from the target checkout by file URL.
    return source.replace(
      /(const changedNodeTestPlan = await )importTargetPlan\([\s\S]*?\n\);/u,
      '$1import("./lib/ci-changed-node-test-plan.mts");',
    );
  }
  if (path.resolve(filePath) === path.resolve("scripts/prepare-native-protocol.mjs")) {
    // The temporary esbuild bundle exports this source module's unchanged API.
    return source.replace(
      "import(pathToFileURL(bundlePath).href)",
      'import("../packages/gateway-protocol/scripts/native-codegen.ts")',
    );
  }
  const typedShimImplementation = source.match(
    /\brun(?:Node|Tsx)CliShim\(\s*import\.meta\.url\s*,\s*\{[\s\S]*?\bimplementation\s*:\s*["'](\.\/[^"'\r\n]+\.mts)["']/u,
  )?.[1];
  if (typedShimImplementation) {
    // Keep implementation exports auditable: the shim executes the module but
    // does not consume every named export merely by loading it.
    return `${source}\nimport ${JSON.stringify(typedShimImplementation)};`;
  }
  return source;
}

function compileUpdateCompatibilityConsumers(rootDir: string): string[] {
  using parser = createNativeTypeScriptParser({ cwd: rootDir });
  const graph = new ModuleGraph(parser, rootDir);
  const inventory = readUpdateCompatibilityInventory(
    path.join(rootDir, "scripts/lib/update-compat-inventory.json"),
  );
  const recordedOrigins = new Map<string, { module: string; symbol: string }>();
  for (const release of inventory.releases) {
    for (const chunk of release.chunks) {
      for (const { origin } of chunk.exports) {
        recordedOrigins.set(`${origin.module}:${origin.symbol}`, origin);
      }
    }
  }
  const imports: string[] = [];
  const origins = [...recordedOrigins.values()].toSorted((left, right) =>
    `${left.module}:${left.symbol}`.localeCompare(`${right.module}:${right.symbol}`),
  );
  for (const [index, origin] of origins.entries()) {
    const sourceFile = path.join(rootDir, origin.module);
    if (graph.names(sourceFile).includes(origin.symbol)) {
      imports.push(
        `import { ${origin.symbol} as __updateCompatibilityConsumer${index} } from ${JSON.stringify(`./${origin.module}`)};`,
      );
      continue;
    }
    const currentOrigin = graph.localOrigin(sourceFile, origin.symbol);
    if (
      !currentOrigin ||
      (currentOrigin.module === origin.module && currentOrigin.symbol === origin.symbol) ||
      !graph.names(path.join(rootDir, currentOrigin.module)).includes(currentOrigin.symbol)
    ) {
      throw new Error(
        `Recorded updater binding ${origin.module}:${origin.symbol} is neither a named export nor an imported named binding`,
      );
    }
  }
  return imports;
}

function compileBundledPackageConsumers(source: string, filePath: string): string {
  const manifestPath = path.resolve(filePath);
  if (
    manifestPath === path.resolve("package.json") ||
    manifestPath === path.resolve("packages/ai/package.json")
  ) {
    // The bundled SDK imports these runtime externals. Project the real build
    // policy into each shipping manifest; the root config alone has one owner.
    const manifest: {
      dependencies?: Record<string, string>;
    } = JSON.parse(source);
    const neverBundle = aiBuildConfig.deps?.neverBundle;
    if (typeof neverBundle !== "function") {
      throw new Error("Expected the AI build's externalization callback.");
    }
    const imports = Object.keys(manifest.dependencies ?? {})
      .filter((dependency) => neverBundle(dependency, undefined, false))
      .map((dependency) => `import ${JSON.stringify(dependency)};`);
    if (manifestPath === path.resolve("package.json")) {
      imports.push(...compileUpdateCompatibilityConsumers(path.dirname(manifestPath)));
    }
    return imports.join("\n");
  }
  // JSON has no import graph in Knip unless a compiler supplies one.
  return "";
}

function bundledPluginWorkspace(extraEntries: readonly string[] = []) {
  return {
    entry: [...bundledPluginEntries, ...extraEntries],
    project: ["**/*.{js,jsx,mjs,ts,tsx}!"],
    ignoreDependencies: bundledPluginIgnoredRuntimeDependencies,
  } as const;
}

// These files are test infrastructure, so their exports are intentionally
// available to tests without becoming part of the production dead-code scan.
const ignoredTestSupportFiles = [
  "**/__tests__/**",
  "**/test/**",
  "src/test-utils/**",
  "**/test-helpers/**",
  "**/test-fixtures/**",
  "**/test-support/**",
  "**/test-*.ts",
  "**/vitest*.{ts,mjs}",
  "**/*test-helpers.ts",
  "**/*test-fixtures.ts",
  "**/*test-harness.ts",
  "**/*test-utils.ts",
  "**/*test-support.ts",
  "**/*.test-loader.ts",
  "**/*.live-helpers.ts",
  "**/*.live-probe-helpers.ts",
  "**/*test-shared.ts",
  "**/*mocks.ts",
  "**/*.e2e-mocks.ts",
  "**/*.e2e-*.ts",
  "**/*.fixture-test-support.ts",
  "**/*.harness.ts",
  "**/*.job-fixtures.ts",
  "**/*.mock-harness.ts",
  "**/*.menu-test-support.ts",
  "**/*.suite-helpers.ts",
  "**/*.test-setup.ts",
  "**/job-fixtures.ts",
  "**/*test-mocks.ts",
  "**/*test-runtime*.ts",
  "**/*.mock-setup.ts",
  "**/*.cases.ts",
  "**/*.e2e-harness.ts",
  "**/*.fixture.ts",
  "**/*.fixtures.ts",
  "**/*.mocks.ts",
  "**/*.mocks.shared.ts",
  "**/*.route-test-support.ts",
  "**/*.shared-test.ts",
  "**/*.suite.ts",
  "**/*.test-runtime.ts",
  "**/*.testkit.ts",
  "**/*.test-fixtures.ts",
  "**/*.test-harness.ts",
  "**/*.test-helper.ts",
  "**/*.test-helpers.ts",
  "**/*.test-mocks.ts",
  "**/*.test-utils.ts",
  "test/helpers/live-image-probe.ts",
  // Legacy test-only owners whose filenames predate the test-support convention.
  "src/plugins/contracts/host-hook-fixture.ts",
  "src/plugins/contracts/tts-contract-suites.ts",
] as const;

const config = {
  compilers: {
    yml: compileWorkflowConsumers,
    sh: compileShellConsumers,
    mjs: compileDynamicMjsConsumers,
    json: compileBundledPackageConsumers,
  },
  ignoreFiles: [
    // Production mode excludes dev/maintainer executables. The full-tree
    // companion config removes this exclusion and audits them as script roots.
    "scripts/**",
    "dist/**",
    "packages/*/dist/**",
    // Declaration companions describe executable JavaScript modules; they are not standalone roots.
    "scripts/**/*.d.{mts,ts}",
    // MCP compatibility tests launch these subprocess fixtures by path; the full-tree scan owns them.
    "extensions/browser/src/browser/chrome-mcp.v1-peer.fixture.mjs",
    "extensions/qa-lab/src/suite-runtime-agent-tools.v1-peer.fixture.mjs",
    // The Telegram context test loads this Worker by URL; the full-tree test scan owns it.
    bundledPluginFile("telegram", "src/telegram-ingress-worker.context.test-support.mjs"),
    "**/live-*.ts",
    // This worker-thread proof entry is loaded from its test with new URL(),
    // which Knip cannot discover as a static import.
    "src/worker/repro-worker-connection-closing-window.ts",
    // Dormant host half of the durable cross-store source fence (#168018). Its real
    // broker tests are the only importer until GitHub publication, session titles,
    // or worktree finalization adopt it; drop this entry with that first caller.
    "src/infra/sqlite-source-fence-admission.ts",
    "src/shared/text/assistant-visible-text.ts",
    bundledPluginFile("telegram", "src/draft-chunking.ts"),
  ],
  // Knip's `ignoreFiles` only suppresses unused-file findings. Test helpers
  // belong in `ignore` so they do not inflate unused-export/type findings.
  ignore: [
    "dist/**",
    "packages/*/dist/**",
    "**/.boundary-stubs/**",
    ...ignoredTestSupportFiles.map((pattern) => pattern.replace(/\.ts$/u, ".{ts,tsx}")),
  ],
  // Script exports are checked with every script as an entry and entry-export
  // reporting enabled. Suppress them only in this application-production scan.
  ignoreIssues: {
    // P3-6c.1 stages manifest write/archive and typed replacement outcomes for P3-6c.2.
    // Remove these production-only exceptions when the offline port caller lands;
    // the full-tree audit still checks all exports against their boundary tests.
    "src/infra/database-port-recovery.ts": ["exports"],
    "src/infra/sqlite-snapshot.ts": ["exports"],
    "scripts/**": ["exports", "nsExports", "types", "nsTypes", "enumMembers", "namespaceMembers"],
    // PR2a admits physical facts now; PR2b routes state maintenance to these capabilities.
    // The full-tree test-aware scan still audits their boundary-test consumers.
    "src/infra/database-engine/physical-facts.ts": ["exports"],
    // Focused config-migration and exec-approval tests exercise these semantic owners directly;
    // the full-tree scan still audits both consumer contracts.
    "src/commands/doctor/shared/context-engine-plugin-id-selector.ts": ["exports"],
    "src/gateway/worker-environments/worker-exec-approval.ts": ["exports"],
    // The full-tree companion config makes tests entrypoints; these contracts
    // are intentionally test-only in the production graph.
    // Native-command tests exercise requester authorization and cancellation at this runtime gate.
    "src/auto-reply/reply/request-native-subagent.ts": ["exports"],
    // Scheduled-command tests exercise registry replacement and persisted-job validation at the owner.
    "src/gateway/plugin-command-scheduled-run.ts": ["exports"],
    // Diagnostic fixtures reset owner-private state; the full-tree audit checks these consumers.
    "src/logging/diagnostic-memory.ts": ["exports"],
    "src/logging/diagnostic-phase.ts": ["exports"],
    "src/logging/diagnostic-run-activity.ts": ["exports"],
    "src/logging/diagnostic-runtime.ts": ["exports"],
    "src/logging/diagnostic-session-recovery-coordinator.ts": ["exports"],
    "src/logging/diagnostic-session-state.ts": ["exports"],
    "src/logging/diagnostic-stability.ts": ["exports"],
    "src/boards/board-notices.ts": ["exports"],
    "src/boards/board-store.ts": ["exports"],
    "src/gateway/board-view-ticket.ts": ["exports"],
    // Focused startup tests consume this explicit seam; production imports only the bootstrap.
    "src/gateway/server-startup-bootstrap.ts": ["exports"],
    // Registry facades retain direct registration/reset compatibility seams used by focused
    // tests; the full-tree scan still audits every named export against those consumers.
    "src/agents/harness/registry.ts": ["exports"],
    // Focused outbox tests seed and recover rows through these kernels; production
    // reaches them only through the agent database worker's command dispatcher.
    "src/agents/harness/context-engine-turn-outbox.kernel.worker.ts": ["exports"],
    // Runtime reason values are exported now so protocol schemas can derive from one tuple later.
    "src/agents/failover/signal.ts": ["exports"],
    "src/context-engine/registry.ts": ["exports", "types"],
    "src/plugins/interactive-registry.ts": ["exports"],
    "src/plugins/memory-state.ts": ["exports", "types"],
    "src/plugins/session-discussion-registry.ts": ["exports"],
    // Focused Control UI tests consume these explicit state-machine seams;
    // production uses them through their owning module/controller.
    "ui/src/pages/chat/chat-state-refresh.{ts,tsx}": ["exports"],
    "ui/src/pages/chat/composer-persistence.{ts,tsx}": ["exports"],
    // Focused link tests build the resolver directly; production reaches it through projectSubagentStatus.
    "ui/src/pages/chat/chat-subagent-wait.ts": ["exports"],
    // The presentation fixture and focused UI tests consume these seams;
    // the full-tree companion scan continues to audit their actual consumers.
    "ui/src/components/terminal/terminal-panel.ts": ["types"],
    "ui/src/pages/chat/components/chat-attachment-card-solid.tsx": ["exports"],
    "ui/src/pages/chat/components/chat-camera-capture.tsx": ["types"],
    "ui/src/pages/chat/components/chat-ci-automation-control.tsx": ["types"],
    "ui/src/pages/chat/components/chat-ci-details.tsx": ["types"],
    "ui/src/pages/chat/components/chat-clawhub-card.tsx": ["exports"],
    "ui/src/pages/chat/components/chat-details.tsx": ["types"],
    "ui/src/pages/chat/components/chat-question-card{,-view}.{ts,tsx}": ["types"],
    "ui/src/pages/chat/components/chat-skill-learned-notice.tsx": ["exports"],
    "ui/src/pages/chat/components/chat-svg-attachment.tsx": ["exports"],
    "ui/src/pages/chat/components/chat-summary-automations.tsx": ["types"],
    "ui/src/pages/chat/components/chat-tool-output{,-view}.{ts,tsx}": ["exports"],
    "ui/src/pages/chat/components/session-diff-panel.tsx": ["exports"],
    "ui/src/pages/model-providers/data.ts": ["exports"],
    "ui/src/pages/plugins/credential-editor.tsx": ["types"],
    "ui/src/pages/plugins/skill-preview.tsx": ["exports"],
    // Focused media tests consume these explicit seams; production uses the helpers in-module.
    "src/agents/embedded-agent-subscribe.handlers.lifecycle.ts": ["exports"],
    "src/gateway/server-methods/chat-webchat-media.ts": ["exports"],
    // Greeting cache/fact contracts (hash, alert text, store shapes) are
    // asserted by the focused greeting unit tests, not by another prod module.
    "src/system-agent/greeting.ts": ["exports", "types"],
    // Focused tests consume these diagnostic/test seams; production code uses
    // the surrounding runtime helpers rather than importing the exports.
    "extensions/signal/src/setup-core.ts": ["exports"],
    // Focused CLI tests exercise plan construction through this explicit test seam.
    "extensions/onepassword/src/secret-ref-cli.ts": ["exports"],
    // Mirror config parsing, redaction mapping, cap fitting, and the runner are
    // asserted by the focused Beam mirror tests; production wires only the service.
    "extensions/beam/src/mirror.ts": ["exports", "types"],
    // Knowledge's focused tests assert response budgets, link parsing, keyword
    // expressions, flush request IDs, descriptor paths, memory-index pinning and
    // labels, compact search limits and the worker operation table through these
    // seams; production reaches them through service handlers and the prompt hook.
    "extensions/knowledge/src/connections.ts": ["exports"],
    "extensions/knowledge/src/ingestion-contract.ts": ["exports", "types"],
    "extensions/knowledge/src/inspection.ts": ["exports"],
    "extensions/knowledge/src/markdown-links.ts": ["exports"],
    "extensions/knowledge/src/memory-index-hook.ts": ["exports"],
    "extensions/knowledge/src/memory-index.ts": ["exports"],
    "extensions/knowledge/src/retrieval.ts": ["exports"],
    "extensions/knowledge/src/search-detail.ts": ["exports"],
    "extensions/knowledge/src/service.ts": ["exports"],
    "extensions/knowledge/src/source-descriptors.ts": ["exports"],
    "extensions/knowledge/src/storage-host.ts": ["exports"],
    "src/infra/heartbeat-wake.ts": ["exports"],
    // Lazy loaders import these modules opaquely (media-understanding runner, config model
    // validation), which Knip counts as using every export until a bare namespace reference
    // disables that shortcut: plugin-test-runtime's isolated-completion fixture passes these
    // namespaces to vi.spyOn. Plain unused exports stay reported here; the full-tree scan
    // still audits every export against its test consumers.
    "src/agents/model-auth.ts": ["nsExports"],
    "src/agents/model-auth-runtime.ts": ["nsExports"],
    "src/agents/model-auth-runtime-shared.ts": ["nsExports"],
    "src/agents/prepared-model-runtime.ts": ["nsExports"],
  },
  workspaces: {
    ".": {
      ignoreDependencies: [
        "@openclaw/*",
        // Cloudflare template dependency: declared in scripts/cloudflare/package.json
        // (isolated deploy tooling), not in the root manifest.
        "@cloudflare/containers",
        // Docker packaging stages @openclaw/ai without nested dependencies after
        // verifying the root owns its exact runtime dependency versions.
        "@mistralai/mistralai",
        "openai",
        "cross-spawn",
        "file-type",
        // Loaded via createRequire in src/agents/utils/syntax-highlight.ts because its
        // d.ts force-includes lib.dom; knip cannot see the dynamic require.
        "highlight.js",
        // Solid plugin builds createRequire the compiler from the plugin author's package.json;
        // the host never resolves or ships it (docs/plugins/feature-plugins.md).
        "@solidjs/compiler",
        // Canvas bundling resolves these from extensions/canvas/package.json.
        "@solidjs/web",
        "solid-js",
        "playwright-core",
        "partial-json",
        // The bundled AI runtime loads Bun proxy support through a computed import.
        "proxy-from-env",
        // The native Canvas bundle falls back without optional Markdown support.
        "sqlite-vec",
        "tree-sitter-bash",
        ...rootToolingAndWorkspaceDependencies,
        ...rootBundledPluginRuntimeDependencies,
      ],
      // Platform tools, installed CLIs, and shell builtins used by scripts and boundary tests.
      ignoreBinaries: [
        "ffmpeg",
        "lsattr",
        "mint",
        // Muse E2E setup installs this CLI outside npm (scripts/e2e/lib/muse-runtime/setup.sh).
        "muse",
        "ngrok",
        "open",
        "openclaw",
        "sleep",
        "swiftlint",
        "uptime",
        "xcrun",
      ],
      // The stylelint config lives under config/, not a root default path.
      stylelint: { config: ["config/stylelint.config.mjs"] },
      // Maintained package commands select these opt-in Vitest configs outside
      // the default root patterns. Config ownership keeps their defaults live.
      vitest: {
        config: [
          "vitest.config.{js,mjs,ts,cjs,mts,cts}",
          "vitest.{workspace,projects}.{js,mjs,ts,cjs,mts,cts,json}",
          "scripts/control-ui-parity/vitest.config.ts",
          "scripts/control-ui-retention/vitest.config.ts",
        ],
      },
      project: [
        ".github/actions/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "apps/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "config/**/*.{ts,mts,cts}!",
        "config/knip-dynamic-consumers.mjs!",
        "config/knip-vite-consumers.mjs!",
        "docs/**/*.js!",
        "security/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "skills/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "src/**/*.ts!",
        "scripts/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "test/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "*.config.{js,mjs,cjs,ts,mts,cts}!",
        "*.mjs!",
      ],
      entry: ["package.json!", ...rootEntries],
    },
    "examples/ai-chat": {
      entry: ["index.mjs!"],
      project: ["**/*.{js,mjs,cjs,ts,mts,cts}!"],
    },
    "examples/inline-incident": {
      entry: ["index.ts!", "control-ui.ts!"],
      project: ["**/*.{js,mjs,cjs,ts,mts,cts}!"],
    },
    "qa/convex-credential-broker": {
      // Convex discovers these registered functions and schemas by filename.
      entry: ["convex/credentials.ts!", "convex/crons.ts!", "convex/http.ts!", "convex/schema.ts!"],
      // This intentionally standalone package is not linked into the pnpm workspace.
      ignoreBinaries: ["convex"],
      project: ["convex/**/*.ts!"],
    },
    ui: {
      entry: [
        // The standalone proof-video skill imports this developer API by path.
        "src/test-helpers/proof-video.ts!",
        "index.html!",
        "src/main.{ts,tsx}!",
        // The generated foreign-locale modules import this factory by absolute path.
        "src/i18n/lib/lazy-catalog.ts!",
        "src/lib/browser-redact.{ts,tsx}!",
        "vite.config.ts!",
        "vitest*.ts!",
        // The standalone Solid compiler smoke is not a production import.
        "src/solid-smoke/solid-smoke.tsx!",
        // Solid presentation primitives (#168576) and the chat render lifecycle (#168657) land
        // before their page and chat consumers; drop each entry with its first production importer.
        "src/components/solid/*.tsx!",
        "!src/components/solid/*.test.tsx!",
        "src/components/icon-data*.ts!",
        "src/app/shell-layout-traits-solid.tsx!",
        "src/pages/chat/solid-render-lifecycle.ts!",
      ],
      // Workboard lazy-loads Three.js at runtime; Knip's dependency pass misses it.
      ignoreDependencies: ["three"],
      project: ["src/**/*.{ts,tsx}!"],
    },
    "packages/ai": {
      // Computed to preserve the browser build boundary.
      ignoreDependencies: ["proxy-from-env"],
      // Mirror the published export map so knip sees every dist entry point.
      entry: [
        // The JSON compiler models the shared build's external runtime consumers.
        "package.json!",
        "src/index.ts!",
        "src/provider-types.ts!",
        "src/providers.ts!",
        "src/types.ts!",
        "src/validation.ts!",
        "src/utils/diagnostics.ts!",
        "src/utils/event-stream.ts!",
        "src/internal/*.ts!",
      ],
      project: ["src/**/*.ts!"],
    },
    "packages/sdk": workspacePackage("sdk"),
    "packages/agent-core": {
      entry: [
        "src/index.ts!",
        "src/agent.ts!",
        "src/agent-loop.ts!",
        "src/llm.ts!",
        "src/runtime-deps.ts!",
        "src/validation.ts!",
        "src/types.ts!",
        "src/harness/messages.ts!",
        "src/harness/env/kill-tree.ts!",
        "src/harness/prompt-template-arguments.ts!",
        "src/harness/utils/truncate.ts!",
      ],
      project: ["src/**/*.ts!"],
    },
    "packages/gateway-client": workspacePackage("gateway-client"),
    "packages/gateway-protocol": workspacePackage("gateway-protocol"),
    "packages/model-catalog-core": workspacePackage("model-catalog-core"),
    "packages/normalization-core": workspacePackage("normalization-core", [
      // extensions/qa-lab/web/vite.config.ts aliases error-runtime to this private browser implementation.
      "src/browser-error-runtime.ts!",
    ]),
    "packages/net-policy": workspacePackage("net-policy"),
    "packages/markdown-core": workspacePackage("markdown-core"),
    "packages/media-core": workspacePackage("media-core"),
    "packages/mermaid-renderer": {
      // Vite selects the native adapter and classic compiler by file path, not imports.
      entry: ["src/renderer.ts!", "src/native.ts!", "src/pele.min.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/acp-core": workspacePackage("acp-core"),
    "packages/terminal-core": workspacePackage("terminal-core"),
    "packages/retry": workspacePackage("retry"),
    "packages/worker-runtime": workspacePackage("worker-runtime"),
    "packages/media-generation-core": workspacePackage("media-generation-core"),
    "packages/media-understanding-common": workspacePackage("media-understanding-common"),
    "packages/memory-host-sdk": {
      entry: ["src/*.ts!", "src/host/embeddings.types.ts!"],
      project: ["src/**/*.ts!"],
    },
    "packages/*": {
      entry: ["index.js!", "scripts/postinstall.js!"],
      project: ["index.js!", "scripts/**/*.js!"],
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/abliteration`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/amazon-bedrock-mantle`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/amazon-bedrock`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/anthropic`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/anthropic-vertex`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/acpx`]: bundledPluginWorkspace([
      // Spawned by the real-process elicitation regression through CODEX_PATH.
      "test/fixtures/codex-app-server.mjs!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/azure-speech`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/browser`]: bundledPluginWorkspace([
      // Core and plugin-SDK facades resolve these shipped Browser surfaces by basename.
      "browser-control-auth.ts!",
      "browser-config.ts!",
      "browser-doctor.ts!",
      "browser-maintenance.ts!",
      "browser-profiles.ts!",
      // Built by tsdown as the native messaging executable; Chrome launches it by path.
      "native-host-entry.ts!",
      "relay-daemon-entry.ts!",
      // Chrome manifest/package scripts load these without TypeScript imports.
      "chrome-extension/background.js!",
      "chrome-extension/options.js!",
      "chrome-extension/popup.js!",
      "scripts/copy-chrome-extension.mjs!",
      // The opt-in browser benchmark is documented and invoked directly by path.
      "scripts/bench-lightweight.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/canvas`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/cloudflare-ai-gateway`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/chutes`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/clawrouter`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/cohere`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/comfy`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/copilot`]: bundledPluginWorkspace([
      // The plugin README invokes this benchmark and its NODE_OPTIONS preload by path.
      "test/bench-attempt-transcript-journal.ts!",
      "test/journal-allocation-probe.mjs!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/copilot-proxy`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/codex`]: bundledPluginWorkspace([
      // Provider runtime and harness surfaces are reached through plugin
      // registration contracts rather than static imports from the entrypoint.
      "harness.ts!",
      "media-understanding-provider.ts!",
      // The validator generator compiles this schema owner into checked-in production modules.
      "src/app-server/protocol-validator-schemas.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/deepgram`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/deepinfra`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/discord`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/diffs`]: bundledPluginWorkspace([
      // scripts/build-diffs-viewer-runtime.mts bundles this browser entry.
      "src/viewer-client.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/elevenlabs`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/featherless`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/fal`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/fireworks`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/google`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/huggingface`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/github-copilot`]: bundledPluginWorkspace([
      // Auth, replay, token, and stream helpers are runtime-owned provider
      // surfaces consumed through plugin hooks and dynamic imports.
      "connection-bound-ids.ts!",
      "login.ts!",
      "stream.ts!",
      "token.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/kilocode`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/kimi-coding`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/knowledge`]: {
      ...bundledPluginWorkspace([
        // knowledge-source-ingest/SKILL.md has agents run these bundled scripts by path.
        "skills/knowledge-source-ingest/scripts/chat-transcript.mjs!",
        "skills/knowledge-source-ingest/scripts/discrawl-normalize.mjs!",
        "skills/knowledge-source-ingest/scripts/source-manifest.mjs!",
        // skill-packaging.test.ts runs this skill-reference generator with --check.
        "scripts/sync-skill-references.mjs",
      ]),
      // discrawl-normalize.mjs reads the user's own Discord archive through the discrawl CLI.
      ignoreBinaries: ["discrawl"],
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/matrix`]: bundledPluginWorkspace([
      // The monitor lazy-loads outbound behavior on inbound-only processes.
      "src/matrix/send.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/microsoft`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/memory-core`]: bundledPluginWorkspace([
      // The subprocess boundary tests spawn these fixtures by computed URL.
      "src/memory/fixtures/manager-search-knn-child.fixture.mjs!",
      "src/memory/fixtures/manager-search-knn-parent.test-support.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/memory-lancedb`]: {
      ...bundledPluginWorkspace(),
      // LanceDB declares Arrow as a peer; the plugin provides it for runtime table values.
      ignoreDependencies: [...bundledPluginIgnoredRuntimeDependencies, "apache-arrow"],
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/microsoft-foundry`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/migrate-claude`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/migrate-hermes`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/minimax`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/mistral`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/moonshot`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/mxc`]: bundledPluginWorkspace([
      // Copied to dist and spawned by the MXC backend.
      "src/mxc-spawn-launcher.mjs!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/nvidia`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/openai`]: {
      ...bundledPluginWorkspace([
        // OpenAI exposes provider, OAuth, overlay, media, usage, and realtime
        // contracts to runtime/plugin integration paths that Knip cannot trace.
        "embedding-batch.ts!",
        "media-understanding-provider.ts!",
        "model-route-contract.ts!",
        "native-web-search.ts!",
        "openai-chatgpt-oauth-flow.runtime.ts!",
        "openai-chatgpt-oauth.runtime.ts!",
        "openai-chatgpt-provider.runtime.ts!",
        "openai-provider.ts!",
        "prompt-overlay.ts!",
        "realtime-provider-shared.ts!",
        "tts.ts!",
        "usage.ts!",
      ]),
      // Werift loads the packaged binary codec through its runtime dependency graph.
      ignoreDependencies: [...bundledPluginIgnoredRuntimeDependencies, "@shinyoshiaki/binary-data"],
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/onepassword`]: bundledPluginWorkspace([
      // Shipped resolver child process declared as a static plugin artifact.
      "onepassword-secret-ref-resolver.js!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/opencode`]: bundledPluginWorkspace([
      // Session catalog and provider helpers are plugin-owned runtime surfaces.
      "media-understanding-provider.ts!",
      "provider-catalog.ts!",
      "session-catalog-plugin.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/opencode-go`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/openrouter`]: bundledPluginWorkspace([
      // OAuth, model, and media provider helpers are runtime/plugin surfaces.
      "image-generation-provider.ts!",
      "media-understanding-provider.ts!",
      "models.ts!",
      "oauth.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/pixverse`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/qianfan`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/qwen`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/qa-lab`]: bundledPluginWorkspace([
      // The private QA Gateway package profile builds this entry by path.
      "gateway-entry.ts!",
      // Core loads the CLI facade by basename; QA Lab also owns a nested Vite app.
      "cli.ts!",
      "web/index.html!",
      "web/src/app.ts!",
      "web/src/main.ts!",
      "web/vite.config.ts!",
      // Imported directly from the GitHub Actions smoke-plan script.
      "src/ci-smoke-plan.ts!",
      // Imported directly from the GitHub Actions evidence workflow.
      "src/profile-evidence-sharding.ts!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/senseaudio`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/slack`]: {
      ...bundledPluginWorkspace([
        // The vendor integrity test executes this verifier by path.
        "scripts/verify-official-skills.mjs!",
      ]),
      // @slack/bolt loads Socket Mode, whose Undici 7 peer must be provided by the plugin.
      ignoreDependencies: [...bundledPluginIgnoredRuntimeDependencies, "undici"],
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/tavily`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/tencent`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/vllm`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/vault`]: bundledPluginWorkspace([
      // Shipped resolver child process declared as a static plugin artifact.
      "vault-secret-ref-resolver.js!",
    ]),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/voyage`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/whatsapp`]: {
      ...bundledPluginWorkspace(),
      // Baileys loads its optional audio decoder at runtime for supported media.
      ignoreDependencies: [...bundledPluginIgnoredRuntimeDependencies, "audio-decode"],
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/xiaomi`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/xai`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/llama-cpp`]: {
      entry: bundledPluginEntries,
      project: ["**/*.{js,mjs,ts,tsx}!"],
      ignoreDependencies: bundledPluginIgnoredRuntimeDependencies,
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/lmstudio`]: bundledPluginWorkspace(),
    [`${BUNDLED_PLUGIN_ROOT_DIR}/reef`]: {
      // Reef vendors its wire protocol under protocol/, which owns the noble
      // crypto dependencies. The protocol barrel is the vendored library's
      // public surface, so its exports are intentional even where the channel
      // consumes only a subset.
      entry: [...bundledPluginEntries, "protocol/index.ts!"],
      project: ["**/*.{js,mjs,ts,tsx}!"],
      ignoreDependencies: bundledPluginIgnoredRuntimeDependencies,
    },
    [`${BUNDLED_PLUGIN_ROOT_DIR}/*`]: {
      // Bundled plugins often load their public surface via string specifiers in
      // `index.ts` contracts, so Knip needs these convention-based entry files.
      entry: bundledPluginEntries,
      project: ["**/*.{js,mjs,ts,tsx}!"],
      ignoreDependencies: bundledPluginIgnoredRuntimeDependencies,
    },
  },
} as const;

const configuredWorkspaces = new Map(Object.entries(config.workspaces));
// Declared runtime, setup, worker, and browser roots need no static import edge.
// Keep each plugin's remaining files subject to reachability.
const artifactWorkspaces = Object.fromEntries(
  fs
    .globSync(`${BUNDLED_PLUGIN_ROOT_DIR}/*/package.json`)
    .toSorted()
    .flatMap((manifestPath) => {
      const packageJson = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const browserSource = controlUiSource(packageJson);
      const sources = [
        ...(browserSource ? [browserSource] : []),
        ...collectPluginSourceEntries(packageJson),
      ];
      const workspace = path.dirname(manifestPath).replaceAll("\\", "/");
      const settings =
        configuredWorkspaces.get(workspace) ?? config.workspaces[`${BUNDLED_PLUGIN_ROOT_DIR}/*`];
      return [
        [
          workspace,
          { ...settings, entry: [...settings.entry, ...sources.map((source) => `${source}!`)] },
        ],
      ];
    }),
);

export default { ...config, workspaces: { ...config.workspaces, ...artifactWorkspaces } };
