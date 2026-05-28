import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DMAD_HEARTBEAT_READBACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const REQUIRED_DIRECTORIES = [
  {
    id: "agents-skills",
    label: "Agent skills",
    candidates: [".agents/skills"],
  },
  {
    id: "skills",
    label: "Workspace skills",
    candidates: ["skills"],
  },
  {
    id: "extensions",
    label: "Bundled plugins",
    candidates: ["extensions"],
  },
  {
    id: "hooks",
    label: "Hooks runtime",
    candidates: ["hooks", "src/hooks"],
  },
  {
    id: "cron",
    label: "Cron runtime",
    candidates: ["cron", "src/cron"],
  },
  {
    id: "gateway",
    label: "Gateway runtime",
    candidates: ["gateway", "src/gateway"],
  },
  {
    id: "runtime",
    label: "Core runtime",
    candidates: ["runtime", "src/runtime"],
  },
];

const REQUIRED_FILES = [
  {
    id: "docs-autonomous-runtime",
    label: "Autonomous runtime doc",
    path: "docs/automation/autonomous-runtime.md",
  },
  {
    id: "docs-module-skill-inventory",
    label: "Module skill inventory doc",
    path: "docs/automation/module-skill-inventory.md",
  },
  {
    id: "script-autonomous-inventory",
    label: "Autonomous inventory gate script",
    path: "scripts/openclaw-autonomous-inventory.mjs",
  },
  {
    id: "script-openclaw-cron-direct-runner",
    label: "OpenClaw cron direct runner",
    path: "scripts/openclaw-cron-direct-runner.mjs",
  },
  {
    id: "hook-post-cron-learner",
    label: "Evolution learning post-cron learner hook",
    path: "extensions/evolution-learning/hooks/post-cron-learner.js",
  },
  {
    id: "script-controlled-task-runner",
    label: "Controlled task runner",
    path: "scripts/openclaw-controlled-task-runner.mjs",
  },
  {
    id: "script-openclaw-blackbox-autonomy-tick",
    label: "OpenClaw blackbox autonomy single-tick runner",
    path: "scripts/openclaw-blackbox-autonomy-tick.mjs",
  },
  {
    id: "script-openclaw-blackbox-sync-bridge",
    label: "OpenClaw blackbox bidirectional status sync bridge",
    path: "scripts/openclaw-blackbox-sync-bridge.mjs",
  },
  {
    id: "script-check-openclaw-blackbox-autonomy",
    label: "OpenClaw blackbox autonomy contract check",
    path: "scripts/check-openclaw-blackbox-autonomy.mjs",
  },
  {
    id: "script-dmad-heartbeat-next-safe-readback",
    label: "DMAD heartbeat next-safe readback helper",
    path: "scripts/dmad-heartbeat-next-safe-readback.mjs",
  },
  {
    id: "script-check-dmad-heartbeat-next-safe-readback",
    label: "DMAD heartbeat next-safe readback check",
    path: "scripts/check-dmad-heartbeat-next-safe-readback.mjs",
  },
  {
    id: "script-dmad-heartbeat-next-safe-readback-self-test",
    label: "DMAD heartbeat next-safe readback self-test",
    path: "scripts/dmad-heartbeat-next-safe-readback-self-test.mjs",
  },
  {
    id: "script-openclaw-controlled-paths",
    label: "OpenClaw controlled paths check",
    path: "scripts/check-openclaw-controlled-paths.mjs",
  },
  {
    id: "script-openclaw-minimal-runtime-profile",
    label: "OpenClaw minimal runtime profile check",
    path: "scripts/check-openclaw-minimal-runtime-profile.mjs",
  },
  {
    id: "script-capital-service-status",
    label: "Capital API service status gate",
    path: "scripts/openclaw-capital-service-status.mjs",
  },
  {
    id: "script-capital-telegram-owner",
    label: "Capital API Telegram single-owner gate",
    path: "scripts/openclaw-capital-telegram-owner-check.mjs",
  },
  {
    id: "script-capital-live-promotion-gate",
    label: "Capital API live-trading promotion gate",
    path: "scripts/openclaw-capital-live-trading-promotion-gate.mjs",
  },
  {
    id: "script-capital-full-chain-simulation",
    label: "Capital API full-chain simulation gate",
    path: "scripts/openclaw-capital-full-chain-simulation-gate.mjs",
  },
  {
    id: "script-capital-active-page-refresh-plan",
    label: "Capital API active-page refresh plan",
    path: "scripts/openclaw-capital-active-page-refresh-plan.mjs",
  },
  {
    id: "script-capital-active-page-refresh-plan-check",
    label: "Capital API active-page refresh plan check",
    path: "scripts/check-capital-active-page-refresh-plan.mjs",
  },
  {
    id: "script-capital-core-product-freshness-matrix",
    label: "Capital API core product freshness matrix",
    path: "scripts/openclaw-capital-core-product-freshness-matrix.mjs",
  },
  {
    id: "script-capital-core-product-freshness-matrix-check",
    label: "Capital API core product freshness matrix check",
    path: "scripts/check-capital-core-product-freshness-matrix.mjs",
  },
  {
    id: "script-capital-direct-operation-status",
    label: "Capital API direct operation status",
    path: "scripts/openclaw-capital-direct-operation-status.mjs",
  },
  {
    id: "script-capital-direct-operation-status-check",
    label: "Capital API direct operation status check",
    path: "scripts/check-capital-direct-operation-status.mjs",
  },
  {
    id: "script-capital-direct-operation-inputs",
    label: "Capital API direct operation input templates",
    path: "scripts/openclaw-capital-direct-operation-inputs.mjs",
  },
  {
    id: "script-capital-direct-operation-inputs-check",
    label: "Capital API direct operation input templates check",
    path: "scripts/check-capital-direct-operation-inputs.mjs",
  },
  {
    id: "script-capital-direct-strategy-platform-gate",
    label: "Capital API direct strategy platform gate",
    path: "scripts/openclaw-capital-direct-strategy-platform-gate.mjs",
  },
  {
    id: "script-capital-direct-strategy-platform-gate-check",
    label: "Capital API direct strategy platform gate check",
    path: "scripts/check-capital-direct-strategy-platform-gate.mjs",
  },
  {
    id: "script-capital-strategy-equity-position-sizer-check",
    label: "Capital strategy equity position sizer check",
    path: "scripts/check-capital-strategy-equity-position-sizer.mjs",
  },
  {
    id: "script-capital-high-confidence-paper-rerun-gate",
    label: "Capital API high-confidence paper rerun gate",
    path: "scripts/openclaw-capital-high-confidence-paper-rerun-gate.mjs",
  },
  {
    id: "script-capital-high-confidence-paper-rerun-gate-check",
    label: "Capital API high-confidence paper rerun gate check",
    path: "scripts/check-capital-high-confidence-paper-rerun-gate.mjs",
  },
  {
    id: "script-capital-micro-alternative-paper-rerun-gate",
    label: "Capital API micro alternative paper rerun gate",
    path: "scripts/openclaw-capital-micro-alternative-paper-rerun-gate.mjs",
  },
  {
    id: "script-capital-micro-alternative-paper-rerun-gate-check",
    label: "Capital API micro alternative paper rerun gate check",
    path: "scripts/check-capital-micro-alternative-paper-rerun-gate.mjs",
  },
  {
    id: "script-capital-risk-resized-paper-intent-rerun-gate",
    label: "Capital API risk-resized paper intent rerun gate",
    path: "scripts/openclaw-capital-risk-resized-paper-intent-rerun-gate.mjs",
  },
  {
    id: "script-capital-risk-resized-paper-intent-rerun-gate-check",
    label: "Capital API risk-resized paper intent rerun gate check",
    path: "scripts/check-capital-risk-resized-paper-intent-rerun-gate.mjs",
  },
  {
    id: "script-capital-current-paper-intents-from-target-registry",
    label: "Capital API current paper intents from target registry",
    path: "scripts/openclaw-capital-current-paper-intents-from-target-registry.mjs",
  },
  {
    id: "script-capital-current-paper-intents-from-target-registry-check",
    label: "Capital API current paper intents from target registry check",
    path: "scripts/check-capital-current-paper-intents-from-target-registry.mjs",
  },
  {
    id: "script-capital-live-readiness-simulation",
    label: "Capital API live readiness 500-run simulation",
    path: "scripts/openclaw-capital-live-readiness-simulation.mjs",
  },
  {
    id: "script-capital-live-readiness-simulation-check",
    label: "Capital API live readiness 500-run simulation check",
    path: "scripts/check-capital-live-readiness-simulation.mjs",
  },
  {
    id: "script-capital-live-operator-auto-deactivate-receipt-gate",
    label: "Capital live operator auto-deactivate receipt gate",
    path: "scripts/openclaw-capital-live-trading-operator-auto-deactivate-receipt-gate.mjs",
  },
  {
    id: "script-capital-live-operator-auto-deactivate-receipt-gate-check",
    label: "Capital live operator auto-deactivate receipt gate check",
    path: "scripts/check-capital-live-trading-operator-auto-deactivate-receipt-gate.mjs",
  },
  {
    id: "script-openclaw-telegram-trading-shortcuts",
    label: "OpenClaw Telegram trading shortcuts check",
    path: "scripts/check-openclaw-telegram-trading-shortcuts.mjs",
  },
  {
    id: "script-openclaw-tradingagents-integration",
    label: "OpenClaw TradingAgents integration check",
    path: "scripts/check-openclaw-tradingagents-integration.mjs",
  },
  {
    id: "script-openclaw-tradingagents-runtime",
    label: "OpenClaw TradingAgents runtime check",
    path: "scripts/check-openclaw-tradingagents-runtime.mjs",
  },
  {
    id: "script-openclaw-tradingagents-upstream",
    label: "OpenClaw TradingAgents upstream readiness check",
    path: "scripts/check-openclaw-tradingagents-upstream.mjs",
  },
  {
    id: "script-openclaw-tradingagents-summary",
    label: "OpenClaw TradingAgents summary check",
    path: "scripts/check-openclaw-tradingagents-summary.mjs",
  },
  {
    id: "script-evolution-learning-architecture",
    label: "Evolution learning architecture check",
    path: "scripts/check-openclaw-evolution-learning-architecture.mjs",
  },
  {
    id: "script-openclaw-card-framework",
    label: "OpenClaw card framework check",
    path: "scripts/check-openclaw-card-framework.mjs",
  },
  {
    id: "script-openclaw-card-graph-export",
    label: "OpenClaw card graph export",
    path: "scripts/export-openclaw-card-framework-graph.mjs",
  },
  {
    id: "script-openclaw-card-module-generator",
    label: "OpenClaw card module dry-run generator",
    path: "scripts/generate-openclaw-card-module-dry-run.mjs",
  },
  {
    id: "script-openclaw-card-viewer-render",
    label: "OpenClaw card viewer render",
    path: "scripts/render-openclaw-card-framework-viewer.mjs",
  },
  {
    id: "script-openclaw-source-watch-registry",
    label: "OpenClaw source watch registry generator",
    path: "scripts/openclaw-source-watch-registry.mjs",
  },
  {
    id: "script-openclaw-source-watch-registry-check",
    label: "OpenClaw source watch registry check",
    path: "scripts/check-openclaw-source-watch-registry.mjs",
  },
  {
    id: "script-openclaw-resolver-candidates",
    label: "OpenClaw resolver candidates generator",
    path: "scripts/openclaw-resolver-candidates.mjs",
  },
  {
    id: "script-openclaw-resolver-candidates-check",
    label: "OpenClaw resolver candidates check",
    path: "scripts/check-openclaw-resolver-candidates.mjs",
  },
  {
    id: "script-openclaw-resolver-evidence-lock",
    label: "OpenClaw resolver evidence lock generator",
    path: "scripts/openclaw-resolver-evidence-lock.mjs",
  },
  {
    id: "script-openclaw-resolver-evidence-lock-check",
    label: "OpenClaw resolver evidence lock check",
    path: "scripts/check-openclaw-resolver-evidence-lock.mjs",
  },
  {
    id: "script-openclaw-resolution-workflow",
    label: "OpenClaw resolution workflow generator",
    path: "scripts/openclaw-resolution-workflow.mjs",
  },
  {
    id: "script-openclaw-resolution-workflow-check",
    label: "OpenClaw resolution workflow check",
    path: "scripts/check-openclaw-resolution-workflow.mjs",
  },
  {
    id: "script-openclaw-weak-signal-intake-gate",
    label: "OpenClaw weak-signal intake gate generator",
    path: "scripts/openclaw-weak-signal-intake-gate.mjs",
  },
  {
    id: "script-openclaw-weak-signal-intake-gate-check",
    label: "OpenClaw weak-signal intake gate check",
    path: "scripts/check-openclaw-weak-signal-intake-gate.mjs",
  },
  {
    id: "script-openclaw-okx-api-status-gate",
    label: "OpenClaw OKX API status gate",
    path: "scripts/openclaw-okx-api-status-gate.mjs",
  },
  {
    id: "script-openclaw-okx-api-status-gate-check",
    label: "OpenClaw OKX API status gate check",
    path: "scripts/check-openclaw-okx-api-status-gate.mjs",
  },
  {
    id: "script-openclaw-okx-market-snapshot-loop",
    label: "OpenClaw OKX market snapshot loop",
    path: "scripts/openclaw-okx-market-snapshot-loop.mjs",
  },
  {
    id: "script-openclaw-okx-market-snapshot-loop-check",
    label: "OpenClaw OKX market snapshot loop check",
    path: "scripts/check-openclaw-okx-market-snapshot-loop.mjs",
  },
  {
    id: "script-openclaw-okx-market-snapshot-gate",
    label: "OpenClaw OKX market snapshot gate",
    path: "scripts/openclaw-okx-market-snapshot-gate.mjs",
  },
  {
    id: "script-openclaw-okx-market-snapshot-gate-check",
    label: "OpenClaw OKX market snapshot gate check",
    path: "scripts/check-openclaw-okx-market-snapshot-gate.mjs",
  },
  {
    id: "script-openclaw-okx-market-snapshot-scheduler",
    label: "OpenClaw OKX market snapshot scheduler",
    path: "scripts/openclaw-okx-market-snapshot-scheduler.mjs",
  },
  {
    id: "script-openclaw-okx-market-snapshot-scheduler-check",
    label: "OpenClaw OKX market snapshot scheduler check",
    path: "scripts/check-openclaw-okx-market-snapshot-scheduler.mjs",
  },
  {
    id: "script-openclaw-okx-paper-signal-gate",
    label: "OpenClaw OKX paper signal gate",
    path: "scripts/openclaw-okx-paper-signal-gate.mjs",
  },
  {
    id: "script-openclaw-okx-paper-signal-gate-check",
    label: "OpenClaw OKX paper signal gate check",
    path: "scripts/check-openclaw-okx-paper-signal-gate.mjs",
  },
  {
    id: "script-openclaw-okx-order-proposal-gate",
    label: "OpenClaw OKX order proposal gate",
    path: "scripts/openclaw-okx-order-proposal-gate.mjs",
  },
  {
    id: "script-openclaw-okx-order-proposal-gate-check",
    label: "OpenClaw OKX order proposal gate check",
    path: "scripts/check-openclaw-okx-order-proposal-gate.mjs",
  },
  {
    id: "script-openclaw-okx-order-status-gate",
    label: "OpenClaw OKX order status gate",
    path: "scripts/openclaw-okx-order-status-gate.mjs",
  },
  {
    id: "script-openclaw-okx-order-status-gate-check",
    label: "OpenClaw OKX order status gate check",
    path: "scripts/check-openclaw-okx-order-status-gate.mjs",
  },
  {
    id: "script-openclaw-okx-demo-order-simulation-result-gate",
    label: "OpenClaw OKX demo order simulation result gate",
    path: "scripts/openclaw-okx-demo-order-simulation-result-gate.mjs",
  },
  {
    id: "script-openclaw-okx-demo-order-simulation-result-gate-check",
    label: "OpenClaw OKX demo order simulation result gate check",
    path: "scripts/check-openclaw-okx-demo-order-simulation-result-gate.mjs",
  },
  {
    id: "script-openclaw-okx-paper-audit-log-gate",
    label: "OpenClaw OKX paper audit log gate",
    path: "scripts/openclaw-okx-paper-audit-log-gate.mjs",
  },
  {
    id: "script-openclaw-okx-paper-audit-log-gate-check",
    label: "OpenClaw OKX paper audit log gate check",
    path: "scripts/check-openclaw-okx-paper-audit-log-gate.mjs",
  },
  {
    id: "script-openclaw-okx-paper-audit-summary-gate",
    label: "OpenClaw OKX paper audit summary gate",
    path: "scripts/openclaw-okx-paper-audit-summary-gate.mjs",
  },
  {
    id: "script-openclaw-okx-paper-audit-summary-gate-check",
    label: "OpenClaw OKX paper audit summary gate check",
    path: "scripts/check-openclaw-okx-paper-audit-summary-gate.mjs",
  },
  {
    id: "script-openclaw-okx-current-readiness-summary",
    label: "OpenClaw OKX current readiness summary",
    path: "scripts/openclaw-okx-current-readiness-summary.mjs",
  },
  {
    id: "script-openclaw-okx-current-readiness-summary-check",
    label: "OpenClaw OKX current readiness summary check",
    path: "scripts/check-openclaw-okx-current-readiness-summary.mjs",
  },
  {
    id: "script-openclaw-okx-current-readiness-refresh-workflow",
    label: "OpenClaw OKX current readiness refresh workflow",
    path: "scripts/openclaw-okx-current-readiness-refresh-workflow.mjs",
  },
  {
    id: "script-openclaw-okx-current-readiness-refresh-workflow-check",
    label: "OpenClaw OKX current readiness refresh workflow check",
    path: "scripts/check-openclaw-okx-current-readiness-refresh-workflow.mjs",
  },
  {
    id: "script-openclaw-okx-current-readiness-heartbeat-operation",
    label: "OpenClaw OKX current readiness heartbeat operation",
    path: "scripts/openclaw-okx-current-readiness-heartbeat-operation.mjs",
  },
  {
    id: "script-openclaw-okx-current-readiness-heartbeat-operation-check",
    label: "OpenClaw OKX current readiness heartbeat operation check",
    path: "scripts/check-openclaw-okx-current-readiness-heartbeat-operation.mjs",
  },
  {
    id: "report-openclaw-card-framework-registry",
    label: "OpenClaw card framework registry",
    path: "reports/openclaw-card-framework-cards.json",
  },
  {
    id: "report-openclaw-card-framework-graph",
    label: "OpenClaw card framework graph",
    path: "reports/openclaw-card-framework-graph.json",
  },
  {
    id: "report-openclaw-card-framework-viewer",
    label: "OpenClaw card framework 3D viewer",
    path: "reports/openclaw-card-framework-3d-viewer.html",
  },
  {
    id: "report-openclaw-card-module-generator",
    label: "OpenClaw card module generator dry-run",
    path: "reports/openclaw-card-module-generator-dry-run-latest.json",
  },
  {
    id: "config-openclaw-minimal-runtime-profile",
    label: "OpenClaw minimal runtime profile",
    path: "config/openclaw-minimal-runtime-profile.json",
  },
  {
    id: "config-openclaw-blackbox-autonomy",
    label: "OpenClaw blackbox autonomy config",
    path: "config/openclaw-blackbox-autonomy.json",
    json: {
      schema: "openclaw.blackbox.autonomy.config.v1",
      requiredJsonValues: [
        {
          path: "mode",
          value: "paper_only_blackbox",
        },
        {
          path: "safety.allowLiveTrading",
          value: false,
        },
        {
          path: "safety.noOrderWrite",
          value: true,
        },
      ],
    },
  },
  {
    id: "report-openclaw-blackbox-autonomy",
    label: "OpenClaw blackbox autonomy latest report",
    path: "reports/hermes-agent/state/openclaw-blackbox-autonomy-latest.json",
    json: {
      schema: "openclaw.blackbox.autonomy.tick.v1",
      requiredJsonValues: [
        {
          path: "cycleId",
          nonEmpty: true,
        },
        {
          path: "nextSafeTask",
          nonEmpty: true,
        },
        {
          path: "safety.allowLiveTrading",
          value: false,
        },
        {
          path: "safety.noOrderWrite",
          value: true,
        },
        {
          path: "machineLine",
          contains: "noOrderWrite=true",
        },
      ],
    },
  },
  {
    id: "report-openclaw-blackbox-sync",
    label: "OpenClaw blackbox sync latest report",
    path: "reports/hermes-agent/state/openclaw-blackbox-sync-latest.json",
    json: {
      schema: "openclaw.blackbox.sync-bridge.v1",
      requiredJsonValues: [
        {
          path: "upstreamVersion",
          nonEmpty: true,
        },
        {
          path: "downstreamVersion",
          nonEmpty: true,
        },
        {
          path: "syncStatus",
          nonEmpty: true,
        },
        {
          path: "lastAckAt",
          nonEmpty: true,
        },
        {
          path: "machineLine",
          contains: "noOrderWrite=true",
        },
      ],
    },
  },
  {
    id: "report-openclaw-source-watch-registry",
    label: "OpenClaw source watch registry dry-run",
    path: "reports/openclaw-source-watch-registry-latest.json",
  },
  {
    id: "report-openclaw-resolver-candidates",
    label: "OpenClaw resolver candidates dry-run",
    path: "reports/openclaw-resolver-candidates-latest.json",
  },
  {
    id: "report-openclaw-resolver-evidence-lock",
    label: "OpenClaw resolver evidence lock",
    path: "reports/hermes-agent/state/openclaw-controlled-task-runner-evidence-lock-latest.json",
  },
  {
    id: "report-openclaw-resolution-workflow",
    label: "OpenClaw integrated resolution workflow",
    path: "reports/openclaw-resolution-workflow-latest.json",
  },
  {
    id: "report-openclaw-resolution-workflow-checklist",
    label: "OpenClaw integrated resolution workflow checklist",
    path: "reports/openclaw-resolution-workflow-checklist.md",
  },
  {
    id: "report-openclaw-weak-signal-intake-gate",
    label: "OpenClaw weak-signal intake gate",
    path: "reports/openclaw-weak-signal-intake-gate-latest.json",
  },
  {
    id: "report-openclaw-okx-api-status-gate",
    label: "OpenClaw OKX API status gate report",
    path: "reports/hermes-agent/state/openclaw-okx-api-status-gate-latest.json",
  },
  {
    id: "report-openclaw-okx-market-snapshot-loop",
    label: "OpenClaw OKX market snapshot loop report",
    path: "reports/hermes-agent/state/openclaw-okx-market-snapshot-loop-latest.json",
  },
  {
    id: "report-openclaw-okx-market-snapshot-gate",
    label: "OpenClaw OKX market snapshot gate report",
    path: "reports/hermes-agent/state/openclaw-okx-market-snapshot-gate-latest.json",
  },
  {
    id: "report-openclaw-okx-market-snapshot-scheduler",
    label: "OpenClaw OKX market snapshot scheduler report",
    path: "reports/hermes-agent/state/openclaw-okx-market-snapshot-scheduler-latest.json",
  },
  {
    id: "report-openclaw-okx-paper-signal-gate",
    label: "OpenClaw OKX paper signal gate report",
    path: "reports/hermes-agent/state/openclaw-okx-paper-signal-gate-latest.json",
  },
  {
    id: "report-openclaw-okx-order-proposal-gate",
    label: "OpenClaw OKX order proposal gate report",
    path: "reports/hermes-agent/state/openclaw-okx-order-proposal-gate-latest.json",
  },
  {
    id: "report-openclaw-okx-order-status-gate",
    label: "OpenClaw OKX order status gate report",
    path: "reports/hermes-agent/state/openclaw-okx-order-status-gate-latest.json",
  },
  {
    id: "report-openclaw-okx-demo-order-simulation-result-gate",
    label: "OpenClaw OKX demo order simulation result gate report",
    path: "reports/hermes-agent/state/openclaw-okx-demo-order-simulation-result-gate-latest.json",
  },
  {
    id: "report-openclaw-okx-paper-audit-log-gate",
    label: "OpenClaw OKX paper audit log gate report",
    path: "reports/hermes-agent/state/openclaw-okx-paper-audit-log-latest.json",
  },
  {
    id: "report-openclaw-okx-paper-audit-summary-gate",
    label: "OpenClaw OKX paper audit summary gate report",
    path: "reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json",
  },
  {
    id: "report-openclaw-okx-current-readiness-summary",
    label: "OpenClaw OKX current readiness summary report",
    path: "reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json",
  },
  {
    id: "report-openclaw-okx-current-readiness-refresh-workflow",
    label: "OpenClaw OKX current readiness refresh workflow report",
    path: "reports/hermes-agent/state/openclaw-okx-current-readiness-refresh-workflow-latest.json",
  },
  {
    id: "report-openclaw-okx-current-readiness-heartbeat-operation",
    label: "OpenClaw OKX current readiness heartbeat operation report",
    path: "reports/hermes-agent/state/openclaw-okx-current-readiness-heartbeat-operation-latest.json",
  },
  {
    id: "report-capital-service-status",
    label: "Capital API service status report",
    path: "reports/hermes-agent/state/openclaw-capital-service-status-latest.json",
  },
  {
    id: "report-capital-telegram-owner",
    label: "Capital API Telegram owner report",
    path: "reports/hermes-agent/state/openclaw-capital-telegram-owner-check-latest.json",
  },
  {
    id: "report-capital-live-approval-summary",
    label: "Capital API live-trading approval summary",
    path: "reports/hermes-agent/state/openclaw-capital-live-trading-approval-summary-latest.json",
  },
  {
    id: "report-capital-active-page-refresh-plan",
    label: "Capital API active-page refresh plan report",
    path: "reports/hermes-agent/state/openclaw-capital-active-page-refresh-plan-latest.json",
    json: {
      schema: "openclaw.capital.active-page-refresh-plan.v1",
      allowedStatuses: ["ready_for_operator_refresh", "paper_strategy_gate_ready", "blocked"],
      requiredJsonValues: [
        {
          path: "readOnly",
          value: true,
        },
        {
          path: "liveTradingEnabled",
          value: false,
        },
        {
          path: "writeTradingEnabled",
          value: false,
        },
        {
          path: "sentOrder",
          value: false,
        },
        {
          path: "safety.readOnlyPlanOnly",
          value: true,
        },
      ],
    },
  },
  {
    id: "report-capital-direct-operation-status",
    label: "Capital API direct operation status report",
    path: "reports/hermes-agent/state/openclaw-capital-direct-operation-status-latest.json",
    json: {
      schema: "openclaw.capital.direct-operation-status.v1",
      allowedStatuses: ["blocked", "live_ready_to_send", "dispatch_written_pending_fill"],
      requiredJsonValues: [
        {
          path: "summary.directEntryPoints.telegram",
          value: "sc:tr:direct",
        },
        {
          path: "summary.status",
          nonEmpty: true,
        },
        {
          path: "summary.externalBrokerAdapter.required",
          value: true,
        },
        {
          path: "summary.externalBrokerAdapter.applyReceipt.required",
          value: true,
        },
        {
          path: "summary.externalBrokerAdapter.applyReceipt.owner",
          value: "operator-owned-broker-adapter-only",
        },
        {
          path: "summary.externalBrokerAdapter.applyReceipt.noLiveOrderSent",
          value: true,
        },
        {
          path: "summary.externalBrokerAdapter.applyReceipt.sentOrder",
          value: false,
        },
        {
          path: "summary.externalBrokerAdapter.applyReceipt.validationCommand",
          contains: "capital:trade:adapter-ack-apply-receipt:check",
        },
        {
          path: "summary.sealedOrderIntent.brokerWriteAllowedByOpenClaw",
          value: false,
        },
        {
          path: "summary.safety.directGate",
          nonEmpty: true,
        },
        {
          path: "summary.autoDeactivateReceipt.required",
          value: true,
        },
        {
          path: "summary.autoDeactivateReceipt.heartbeatExecuteAllowed",
          value: false,
        },
        {
          path: "summary.autoDeactivateReceipt.noLiveOrderSent",
          value: true,
        },
        {
          path: "summary.autoDeactivateReceipt.sentOrder",
          value: false,
        },
        {
          path: "summary.autoDeactivateReceipt.validationCommand",
          contains: "capital:live-trading:operator:auto-deactivate:receipt:check",
        },
        {
          path: "summary.position.verifiedAt",
          nonEmpty: true,
        },
        {
          path: "summary.position.freshnessStatus",
          nonEmpty: true,
        },
      ],
    },
  },
  {
    id: "report-capital-direct-operation-inputs",
    label: "Capital API direct operation inputs report",
    path: "reports/hermes-agent/state/openclaw-capital-direct-operation-inputs-latest.json",
    json: {
      schema: "openclaw.capital.direct-operation-inputs.v1",
      status: "ready",
      requiredJsonValues: [
        {
          path: "safety.generatedTemplatesOnly",
          value: true,
        },
        {
          path: "safety.wroteActivePositionSnapshot",
          value: false,
        },
        {
          path: "safety.wroteActiveAdapterAck",
          value: false,
        },
        {
          path: "safety.sentOrder",
          value: false,
        },
        {
          path: "requestedTrade.instrument",
          value: "A50 202605",
        },
        {
          path: "templates.externalBrokerAdapterAckRequiredCurrent.path",
          contains: "capital-external-broker-adapter-ack.required-current.json",
        },
        {
          path: "activeTargets.externalBrokerAdapterAck.expectedSealedIntentSha256",
          nonEmpty: true,
        },
        {
          path: "activeTargets.verifiedPositionSnapshot.freshnessStatus",
          nonEmpty: true,
        },
      ],
    },
  },
  {
    id: "report-capital-direct-strategy-platform-gate",
    label: "Capital API direct strategy platform gate report",
    path: "reports/hermes-agent/state/openclaw-capital-direct-strategy-platform-gate-latest.json",
    json: {
      schema: "openclaw.capital.direct-strategy-platform-gate.v1",
      allowedStatuses: [
        "blocked_quote_not_fresh",
        "blocked_operator_inputs_required",
        "blocked_paper_strategy_not_promoted",
        "blocked_live_promotion_required",
      ],
      requiredJsonValues: [
        {
          path: "strategyPlatform.requestedTrade.instrument",
          value: "A50 202605",
        },
        {
          path: "strategyPlatform.requestedTrade.holdingMode",
          value: "day_trade",
        },
        {
          path: "strategyPlatform.targetRegistry.scope",
          value: "all_registered_capital_futures_routes",
        },
        {
          path: "strategyPlatform.targetRegistry.summary.liveWritableTargetCount",
          value: 0,
        },
        {
          path: "execution.liveWriteAllowed",
          value: false,
        },
        {
          path: "execution.noLiveOrderSent",
          value: true,
        },
        {
          path: "execution.operatorCanExecute",
          value: false,
        },
        {
          path: "liveCompletion.status",
          value: "blocked",
        },
        {
          path: "liveCompletion.noLiveOrderSent",
          value: true,
        },
        {
          path: "liveCompletion.writeBrokerOrders",
          value: false,
        },
        {
          path: "safety.paperOnly",
          value: true,
        },
        {
          path: "safety.writeBrokerOrders",
          value: false,
        },
        {
          path: "safety.codexBrokerWriteAllowed",
          value: false,
        },
      ],
    },
  },
  {
    id: "report-capital-high-confidence-paper-rerun-gate",
    label: "Capital API high-confidence paper rerun gate report",
    path: "reports/hermes-agent/state/openclaw-capital-high-confidence-paper-rerun-gate-latest.json",
    json: {
      schema: "openclaw.capital.high-confidence-paper-rerun-gate.v1",
      allowedStatuses: [
        "high_confidence_candidate_tail_passed_requires_promotion_rerun",
        "high_confidence_rerun_completed_still_blocked",
        "blocked_no_high_confidence_candidate",
      ],
      requiredJsonValues: [
        {
          path: "confidenceGate.threshold",
          value: 0.6,
        },
        {
          path: "confidenceGate.requiredConfidenceStatus",
          nonEmpty: true,
        },
        {
          path: "safetyLock.paperOnly",
          value: true,
        },
        {
          path: "safetyLock.simulatedOnly",
          value: true,
        },
        {
          path: "safetyLock.writeBrokerOrders",
          value: false,
        },
        {
          path: "safetyLock.noLiveOrderSent",
          value: true,
        },
        {
          path: "noOrderWrite",
          value: true,
        },
      ],
    },
  },
  {
    id: "report-capital-micro-alternative-paper-rerun-gate",
    label: "Capital API micro alternative paper rerun gate report",
    path: "reports/hermes-agent/state/openclaw-capital-micro-alternative-paper-rerun-gate-latest.json",
    json: {
      schema: "openclaw.capital.micro-alternative-paper-rerun-gate.v1",
      allowedStatuses: [
        "micro_alternative_candidate_tail_passed_requires_promotion_rerun",
        "micro_alternative_rerun_completed_still_blocked",
        "blocked_no_micro_alternative_ready",
      ],
      requiredJsonValues: [
        {
          path: "source.maxRiskNotional",
          value: 3000,
        },
        {
          path: "safetyLock.paperOnly",
          value: true,
        },
        {
          path: "safetyLock.simulatedOnly",
          value: true,
        },
        {
          path: "safetyLock.writeBrokerOrders",
          value: false,
        },
        {
          path: "safetyLock.noLiveOrderSent",
          value: true,
        },
        {
          path: "noOrderWrite",
          value: true,
        },
      ],
    },
  },
  {
    id: "report-capital-risk-resized-paper-intent-rerun-gate",
    label: "Capital API risk-resized paper intent rerun gate report",
    path: "reports/hermes-agent/state/openclaw-capital-risk-resized-paper-intent-rerun-gate-latest.json",
    json: {
      schema: "openclaw.capital.risk-resized-paper-intent-rerun-gate.v1",
      allowedStatuses: [
        "paper_resized_candidate_tail_passed_requires_promotion_rerun",
        "paper_resized_rerun_completed_still_blocked",
        "blocked_no_rerun_ready",
      ],
      requiredJsonValues: [
        {
          path: "source.riskNotionalReviewStatus",
          nonEmpty: true,
        },
        {
          path: "safetyLock.paperOnly",
          value: true,
        },
        {
          path: "safetyLock.simulatedOnly",
          value: true,
        },
        {
          path: "safetyLock.writeBrokerOrders",
          value: false,
        },
        {
          path: "safetyLock.noLiveOrderSent",
          value: true,
        },
        {
          path: "noOrderWrite",
          value: true,
        },
      ],
    },
  },
  {
    id: "report-capital-current-paper-intents-from-target-registry",
    label: "Capital API current paper intents from target registry report",
    path: "reports/hermes-agent/state/openclaw-capital-current-paper-intents-from-target-registry-latest.json",
    json: {
      schema: "openclaw.capital.current-paper-intents-from-target-registry.v1",
      allowedStatuses: [
        "current_paper_intents_written",
        "blocked_no_fresh_price_targets",
        "blocked_platform_report_missing",
      ],
      requiredJsonValues: [
        {
          path: "source.noBrokerApiCalled",
          value: true,
        },
        {
          path: "targetRegistry.scope",
          value: "all_registered_capital_futures_routes",
        },
        {
          path: "intentWrite.activeIntentsPath",
          value: ".openclaw/trading/capital-paper-intents.jsonl",
        },
        {
          path: "intentWrite.generatedPaperIntentsOnly",
          value: true,
        },
        {
          path: "safety.paperOnly",
          value: true,
        },
        {
          path: "safety.noLiveOrderSent",
          value: true,
        },
        {
          path: "safety.writeBrokerOrders",
          value: false,
        },
        {
          path: "safety.liveTradingEnabled",
          value: false,
        },
      ],
    },
  },
  {
    id: "report-openclaw-telegram-trading-shortcuts",
    label: "OpenClaw Telegram trading shortcuts report",
    path: "reports/hermes-agent/state/openclaw-telegram-trading-shortcuts-latest.json",
    json: {
      schema: "openclaw.telegram-trading-shortcuts.v1",
      status: "pass",
      summaryFailed: 0,
      minSummaryChecks: 107,
      summaryShortcuts: 18,
      requiredJsonValues: [
        {
          path: "summary.assistantClosure.statusStripFixtureCoverage.status",
          value: "pass",
        },
        {
          path: "summary.assistantClosure.statusStripFixtureCoverage.visibleInAssistantStatusStrip",
          value: true,
        },
        {
          path: "summary.assistantClosure.assistantLearningHint.nextCommandShortRow.command",
          value: "sc:tr:audit / sc:tr:paperloop / sc:tr:assist",
        },
        {
          path: "summary.assistantClosure.assistantLearningHint.nextCommandShortRow.gateVerified",
          value: true,
        },
        {
          path: "summary.assistantClosure.assistantLearningHint.nextCommandShortRow.machineLine",
          value:
            "nextCommandShortRow=sc:tr:audit/sc:tr:paperloop/sc:tr:assist gateVerified=true buttons=sc:tr:learn/sc:tr:audit/sc:tr:paperloop/sc:tr:assist",
        },
        {
          path: "summary.okxCurrentReadinessRefreshWorkflowClosure.status",
          value: "ready",
        },
        {
          path: "summary.okxCurrentReadinessRefreshWorkflowClosure.machineLine",
          contains: "okxCurrentReadinessRefresh=",
        },
        {
          path: "summary.okxCurrentReadinessRefreshWorkflowClosure.noOrderWrite",
          value: true,
        },
        {
          path: "summary.okxSchedulerNoOrderContractProbeClosure.status",
          value: "ready",
        },
        {
          path: "summary.okxSchedulerNoOrderContractProbeClosure.machineLine",
          contains: "okxSchedulerNoOrderContract=pass",
        },
        {
          path: "summary.okxSchedulerNoOrderContractProbeClosure.noOrderWrite",
          value: true,
        },
        {
          path: "summary.okxCurrentReadinessInventoryProbeClosure.machineLine",
          contains: "publishProbes=18/18",
        },
        {
          path: "summary.okxHeartbeatPublishTokenCountClosure.status",
          value: "ready",
        },
        {
          path: "summary.okxHeartbeatPublishTokenCountClosure.summaryZhTw",
          contains: "noOrderWrite=true=4",
        },
        {
          path: "summary.okxHeartbeatPublishTokenCountClosure.summaryZhTw",
          contains: "本地執行器=1",
        },
        {
          path: "summary.okxHeartbeatPublishTokenCountClosure.noOrderWrite",
          value: true,
        },
      ],
    },
  },
  {
    id: "report-capital-live-readiness-simulation",
    label: "Capital API live readiness 500-run simulation report",
    path: "reports/hermes-agent/state/openclaw-capital-live-readiness-simulation-latest.json",
    json: {
      schema: "openclaw.capital.live-readiness-simulation.v1",
      allowedStatuses: ["blocked_live_readiness_incomplete", "ready_for_operator_execution_review"],
      requiredJsonValues: [
        {
          path: "simulationRuns",
          value: 500,
        },
        {
          path: "completion.falseAccepted",
          value: 0,
        },
        {
          path: "completion.noLiveOrderSent",
          value: true,
        },
        {
          path: "completion.sentOrder",
          value: false,
        },
        {
          path: "safety.reportOnly",
          value: true,
        },
        {
          path: "safety.simulatedOnly",
          value: true,
        },
        {
          path: "safety.allowLiveTrading",
          value: false,
        },
        {
          path: "safety.writeBrokerOrders",
          value: false,
        },
        {
          path: "safety.sentOrder",
          value: false,
        },
        {
          path: "safety.noLiveOrderSent",
          value: true,
        },
        {
          path: "sealedOrderIntent.sha256",
          nonEmpty: true,
        },
        {
          path: "quoteFreshness.coreProductMatrix.productCount",
          value: 11,
        },
        {
          path: "sourceReports.coreProductMatrix.found",
          value: true,
        },
        {
          path: "nextSafeTask",
          nonEmpty: true,
        },
        {
          path: "machineLine",
          contains: "noLiveOrderSent=true",
        },
      ],
    },
  },
  {
    id: "report-capital-live-operator-auto-deactivate-receipt-gate",
    label: "Capital live operator auto-deactivate receipt gate report",
    path: "reports/hermes-agent/state/openclaw-capital-live-trading-operator-auto-deactivate-receipt-gate-latest.json",
    json: {
      schema: "openclaw.capital.live-trading-operator-auto-deactivate-receipt-gate.v1",
      allowedStatuses: [
        "pending_explicit_execute_receipt",
        "receipt_verified",
        "blocked_receipt_gate_incomplete",
      ],
      requiredJsonValues: [
        {
          path: "auditId",
          nonEmpty: true,
        },
        {
          path: "heartbeatExecuteAllowed",
          value: false,
        },
        {
          path: "safety.reportOnly",
          value: true,
        },
        {
          path: "safety.noLiveOrderSent",
          value: true,
        },
        {
          path: "safety.sentOrder",
          value: false,
        },
        {
          path: "safety.writeBrokerOrders",
          value: false,
        },
        {
          path: "safety.liveTradingEnabled",
          value: false,
        },
        {
          path: "machineLine",
          contains: "capitalAutoDeactivateReceipt=",
        },
        {
          path: "machineLine",
          contains: "heartbeatExecuteAllowed=false",
        },
        {
          path: "machineLine",
          contains: "noOrderWrite=true",
        },
      ],
    },
  },
  {
    id: "report-openclaw-tradingagents-summary",
    label: "OpenClaw TradingAgents summary report",
    path: "reports/hermes-agent/state/openclaw-tradingagents-summary-latest.json",
    json: {
      schema: "openclaw.tradingagents.summary.v1",
      requiredJsonValues: [
        {
          path: "status",
          nonEmpty: true,
        },
        {
          path: "integration.status",
          value: "ok",
        },
        {
          path: "runtime.status",
          value: "ok",
        },
        {
          path: "runtime.provider",
          nonEmpty: true,
        },
        {
          path: "runtime.mode",
          value: "paper_signal_only",
        },
        {
          path: "runtime.noOrderWrite",
          value: true,
        },
        {
          path: "runtime.brokerWriteAttempted",
          value: false,
        },
        {
          path: "canAnalyzeNow",
          value: true,
        },
        {
          path: "no_live_order_sent",
          value: true,
        },
        {
          path: "brokerWriteAttempted",
          value: false,
        },
        {
          path: "nextSafeTask",
          nonEmpty: true,
        },
      ],
    },
  },
  {
    id: "report-openclaw-controlled-task-runner-latest",
    label: "OpenClaw controlled runner latest state report",
    path: "reports/hermes-agent/state/openclaw-controlled-task-runner-latest.json",
    json: {
      schema: "openclaw.controlled-task-runner.report.v1",
      requiredJsonValues: [
        {
          path: "readOnlyMode",
          value: true,
        },
        {
          path: "dmad_validation_hint.command",
          contains: "pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full",
        },
        {
          path: "dmad_publish_status.machineLine",
          contains: "dmadPublish=verified",
        },
        {
          path: "dmad_publish_status.upstreamDmadGateCount",
          value: 1,
        },
        {
          path: "dmad_publish_status.upstreamDmadGateVerified",
          value: true,
        },
        {
          path: "dmad_publish_status.upstreamSummaryHasDmad",
          value: true,
        },
        {
          path: "dmad_publish_status.upstreamOkxContractCount",
          value: 1,
        },
        {
          path: "dmad_publish_status.upstreamOkxContractVerified",
          value: true,
        },
        {
          path: "dmad_publish_status.upstreamSummaryHasOkxContract",
          value: true,
        },
        {
          path: "dmad_publish_status.upstreamSchedulerNextRunAt",
          nonEmpty: true,
        },
        {
          path: "dmad_publish_status.upstreamSchedulerNextRunAtVisible",
          value: true,
        },
        {
          path: "validation_result.telegram_publish.upstreamDmadGateVerified",
          value: true,
        },
        {
          path: "validation_result.telegram_publish.upstreamOkxContractVerified",
          value: true,
        },
        {
          path: "validation_result.telegram_publish.upstreamSchedulerNextRunAt",
          nonEmpty: true,
        },
      ],
    },
  },
  {
    id: "report-openclaw-controlled-task-runner-telegram-summary",
    label: "OpenClaw controlled runner Telegram summary report",
    path: "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-latest.json",
    json: {
      schema: "openclaw.controlled-task-runner.telegram-summary.v1",
      requiredJsonValues: [
        {
          path: "readOnlyMode",
          value: true,
        },
        {
          path: "telegram_trading_shortcuts.exists",
          value: true,
        },
        {
          path: "telegram_trading_shortcuts.status",
          value: "pass",
        },
        {
          path: "telegram_trading_shortcuts.failed",
          value: 0,
        },
        {
          path: "telegram_trading_shortcuts.machineLine",
          contains: "shortcutChecks=",
        },
        {
          path: "telegram_trading_shortcuts.capitalOperatorPacketMachineLine",
          contains: "capitalOperatorPacket=",
        },
        {
          path: "telegram_trading_shortcuts.capitalOperatorPacketMachineLine",
          contains: "noOrderWrite=true",
        },
        {
          path: "telegram_trading_shortcuts.capitalOperatorPacketPublishMachineLine",
          contains: "capitalOperatorPacket=",
        },
        {
          path: "telegram_trading_shortcuts.capitalOperatorPacketPublishMachineLine",
          contains: "operatorCanExecute=",
        },
        {
          path: "telegram_trading_shortcuts.capitalOperatorPacketPublishMachineLine",
          contains: "adapterApplyReceipt=",
        },
        {
          path: "telegram_trading_shortcuts.capitalOperatorPacketPublishMachineLine",
          contains: "adapterApplyReceiptVerified=",
        },
        {
          path: "telegram_trading_shortcuts.capitalOperatorPacketSentOrder",
          value: false,
        },
        {
          path: "telegram_trading_shortcuts.capitalFailedReplayHistoryMachineLine",
          contains: "capitalFailedReplayHistory=banned:",
        },
        {
          path: "telegram_trading_shortcuts.capitalFailedReplayHistoryMachineLine",
          contains: "next=",
        },
        {
          path: "telegram_trading_shortcuts.capitalFailedReplayHistoryMachineLine",
          contains: "noOrderWrite=true",
        },
        {
          path: "telegram_trading_shortcuts.capitalFailedReplayHistoryNoOrderWrite",
          value: true,
        },
        {
          path: "capital_operator_packet.publishMachineLine",
          contains: "capitalOperatorPacket=",
        },
        {
          path: "telegram_trading_shortcuts.nextCommandMachineLine",
          contains: "nextCommandShortRow=",
        },
        {
          path: "telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine",
          contains: "okxHeartbeatRefresh=",
        },
        {
          path: "telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine",
          contains: "executeRequired=",
        },
        {
          path: "telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine",
          contains: "schedulerNextRunAt=",
        },
        {
          path: "telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine",
          contains: "noOrderWrite=true",
        },
        {
          path: "telegram_trading_shortcuts.gateVerified",
          value: true,
        },
        {
          path: "dmad_validation_hint.command",
          contains: "pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full",
        },
        {
          path: "dmad_validation_hint.machineLine",
          contains: "dmadGate=timeout-smoke:gate:ultra:verify:ultra:full",
        },
        {
          path: "dmad_validation_hint.readOnlyMode",
          value: true,
        },
        {
          path: "dmad_publish_status.machineLine",
          contains: "dmadPublish=verified",
        },
        {
          path: "dmad_publish_status.verified",
          value: true,
        },
        {
          path: "dmad_publish_status.upstreamOkxContractCount",
          value: 1,
        },
        {
          path: "dmad_publish_status.upstreamSchedulerNextRunAt",
          nonEmpty: true,
        },
        {
          path: "okx_current_readiness_refresh_workflow.machineLine",
          contains: "okxCurrentReadinessRefresh=",
        },
        {
          path: "okx_current_readiness_refresh_workflow.noOrderWrite",
          value: true,
        },
        {
          path: "trading_readiness_status.machineLine",
          contains: "tradingReadiness=quote:",
        },
        {
          path: "trading_readiness_status.machineLine",
          contains: "simulation=",
        },
        {
          path: "trading_readiness_status.machineLine",
          contains: "orderMode=",
        },
        {
          path: "trading_readiness_status_zh_tw",
          contains: "交易就緒=報價:",
        },
        {
          path: "trading_readiness_status_zh_tw",
          contains: "模擬:",
        },
        {
          path: "trading_readiness_status_zh_tw",
          contains: "下單模式:",
        },
        {
          path: "telegram_summary_oneline",
          contains: "tradingReadiness=quote:",
        },
        {
          path: "telegram_summary_oneline",
          contains: "tradingShortcuts=shortcutChecks=",
        },
        {
          path: "telegram_summary_oneline",
          contains: "operatorPacket=capitalOperatorPacket=",
        },
        {
          path: "telegram_summary_oneline",
          contains: "operatorCanExecute=false",
        },
        {
          path: "telegram_summary_oneline",
          contains: "okxRefresh=okxCurrentReadinessRefresh=",
        },
        {
          path: "telegram_summary_oneline",
          contains: "okxHeartbeat=okxHeartbeatRefresh=",
        },
        {
          path: "telegram_summary_oneline",
          contains: "schedulerNextRunAt=",
        },
        {
          path: "telegram_summary_oneline",
          contains: "shortcutNext=nextCommandShortRow=",
        },
        {
          path: "telegram_summary_oneline",
          contains: "dmadGate=timeout-smoke:gate:ultra:verify:ultra:full",
        },
        {
          path: "telegram_summary_oneline",
          contains: "dmadPublish=verified",
        },
        {
          path: "telegram_summary_oneline",
          contains: "summaryOkxContract=true",
        },
        {
          path: "telegram_summary_oneline_zh_tw",
          contains: "交易就緒=報價:",
        },
        {
          path: "telegram_summary_oneline_zh_tw",
          contains: "模擬:",
        },
        {
          path: "telegram_summary_oneline_zh_tw",
          contains: "下單模式:",
        },
        {
          path: "telegram_summary_oneline_zh_tw",
          contains: "快捷檢查=shortcutChecks=",
        },
        {
          path: "telegram_summary_oneline_zh_tw",
          contains: "真單Packet=capitalOperatorPacket=",
        },
        {
          path: "telegram_summary_oneline_zh_tw",
          contains: "operatorCanExecute=false",
        },
        {
          path: "telegram_summary_oneline_zh_tw",
          contains: "OKX刷新=okxCurrentReadinessRefresh=",
        },
        {
          path: "telegram_summary_oneline_zh_tw",
          contains: "OKX心跳=okxHeartbeatRefresh=",
        },
        {
          path: "telegram_summary_oneline_zh_tw",
          contains: "schedulerNextRunAt=",
        },
        {
          path: "telegram_summary_oneline_zh_tw",
          contains: "下一步指令=nextCommandShortRow=",
        },
        {
          path: "telegram_summary_oneline_zh_tw",
          contains: "DMAD=timeout-smoke:gate:ultra:verify:ultra:full",
        },
        {
          path: "telegram_summary_oneline_zh_tw",
          contains: "dmadPublish=verified",
        },
        {
          path: "telegram_summary_oneline_zh_tw",
          contains: "summaryOkxContract=true",
        },
      ],
    },
  },
  {
    id: "report-openclaw-controlled-task-runner-telegram-summary-markdown",
    label: "OpenClaw controlled runner Telegram summary markdown report",
    path: "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-latest.md",
    text: {
      requiredIncludes: [
        "- capital_operator_packet: capitalOperatorPacket=",
        "- capital_operator_packet_can_execute:",
        "- capital_failed_replay_history: capitalFailedReplayHistory=banned:",
        "- capital_failed_replay_history_no_order_write: true",
        "- trading_readiness_status: tradingReadiness=quote:",
        "- dmad_publish_status: dmadPublish=verified",
        "dmadGate=1;summaryDmad=true",
        "okxContract=1;summaryOkxContract=true",
        "schedulerNextRunAt=",
      ],
    },
  },
  {
    id: "report-openclaw-controlled-task-runner-telegram-publish",
    label: "OpenClaw controlled runner Telegram publish dry-run report",
    path: "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-publish-latest.json",
    json: {
      schema: "openclaw.controlled-task-runner.telegram-publish.report.v1",
      status: "dry_run_ok",
      requiredJsonValues: [
        {
          path: "errorCode",
          value: "OK",
        },
        {
          path: "dryRun",
          value: true,
        },
        {
          path: "dryRunNoSend",
          value: true,
        },
        {
          path: "summaryPath",
          value: "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-latest.json",
        },
        {
          path: "reportPath",
          value:
            "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-publish-latest.json",
        },
        {
          path: "message",
          contains: "快捷檢查=shortcutChecks=",
        },
        {
          path: "message",
          contains: "TradingAgents=tradingAgents=",
        },
        {
          path: "message",
          contains: "noOrderWriteVerified=true",
        },
        {
          path: "message",
          contains: "noLiveOrderSent=true",
        },
        {
          path: "message",
          contains: "brokerWriteAttempted=false",
        },
        {
          path: "message",
          contains: "真單Packet=capitalOperatorPacket=",
        },
        {
          path: "message",
          contains: "operatorCanExecute=false",
        },
        {
          path: "message",
          contains: "倉位快照=capitalVerifiedPositionSnapshot=",
        },
        {
          path: "message",
          contains: "next=sc:tr:directpos",
        },
        {
          path: "message",
          contains: "OKX刷新=okxCurrentReadinessRefresh=",
        },
        {
          path: "message",
          contains: "OKX心跳=okxHeartbeatRefresh=",
        },
        {
          path: "message",
          contains: "OKX合約=okxSchedulerNoOrderContract=",
        },
        {
          path: "message",
          contains: "schedulerNextRunAt=",
        },
        {
          path: "message",
          contains: "executeRequired=",
        },
        {
          path: "message",
          contains: "noOrderWrite=true",
        },
        {
          path: "message",
          contains: "下一步指令=nextCommandShortRow=",
        },
        {
          path: "message",
          contains: "DMAD=timeout-smoke:gate:ultra:verify:ultra:full",
        },
        {
          path: "message",
          contains: "回關收據命令=receiptPrompt=",
        },
        {
          path: "messageTokenCounts.positionSnapshot",
          value: 1,
        },
        {
          path: "messageTokenCounts.tradingAgents",
          value: 1,
        },
        {
          path: "messageTokenCounts.receiptPrompt",
          value: 1,
        },
        {
          path: "messageTokenCounts.okxRefresh",
          value: 1,
        },
        {
          path: "messageTokenCounts.okxHeartbeat",
          value: 1,
        },
        {
          path: "messageTokenCounts.okxContract",
          value: 1,
        },
        {
          path: "messageTokenCounts.executeRequired",
          value: 1,
        },
        {
          path: "messageTokenCounts.noOrderWrite",
          value: 4,
        },
        {
          path: "messageTokenCounts.localExecutorDispatch",
          value: 1,
        },
        {
          path: "messageTokenCounts.dmadGate",
          value: 1,
        },
        {
          path: "messageTokenCountsSummaryZhTw",
          contains: "倉位快照=1",
        },
        {
          path: "messageTokenCountsSummaryZhTw",
          contains: "TradingAgents=1",
        },
        {
          path: "messageTokenCountsSummaryZhTw",
          contains: "回關收據命令=1",
        },
        {
          path: "messageTokenCountsSummaryZhTw",
          contains: "OKX刷新=1",
        },
        {
          path: "messageTokenCountsSummaryZhTw",
          contains: "OKX心跳=1",
        },
        {
          path: "messageTokenCountsSummaryZhTw",
          contains: "OKX合約=1",
        },
        {
          path: "messageTokenCountsSummaryZhTw",
          contains: "noOrderWrite=true=4",
        },
        {
          path: "messageTokenCountsSummaryZhTw",
          contains: "本地執行器=1",
        },
        {
          path: "messageTokenCountsSummaryZhTw",
          contains: "DMAD=1",
        },
        {
          path: "command",
          contains: "--dry-run",
        },
        {
          path: "commandExitCode",
          value: 0,
        },
        {
          path: "commandErrorCode",
          value: "DRY_RUN_NO_SEND",
        },
        {
          path: "next_safe_task",
          value: "pnpm autonomous:controlled:run -- --json",
        },
      ],
    },
  },
  {
    id: "report-dmad-heartbeat-next-safe-readback",
    label: "DMAD heartbeat next-safe readback report",
    path: "reports/hermes-agent/state/openclaw-dmad-heartbeat-next-safe-readback-latest.json",
    json: {
      schema: "openclaw.dmad.heartbeat-next-safe-readback.v1",
      status: "ready",
      generatedAtPath: "generatedAt",
      maxGeneratedAtAgeMs: DMAD_HEARTBEAT_READBACK_MAX_AGE_MS,
      requiredJsonValues: [
        {
          path: "machineLine",
          contains: "nextSafe=",
        },
        {
          path: "machineLine",
          contains: "dmadGate=timeout-smoke:gate:ultra:verify:ultra:full",
        },
        {
          path: "machineLine",
          contains: "dmadPublish=verified",
        },
        {
          path: "nextSafe",
          nonEmpty: true,
        },
        {
          path: "heartbeat.nextSafe",
          nonEmpty: true,
        },
        {
          path: "heartbeat.message",
          contains: "next_safe=",
        },
        {
          path: "heartbeat.xml",
          contains: "<heartbeat>",
        },
        {
          path: "heartbeat.xml",
          contains: "<message>next_safe=",
        },
        {
          path: "automationReadPoint.nextSafe",
          nonEmpty: true,
        },
        {
          path: "automationReadPoint.stdoutRequired",
          value: false,
        },
        {
          path: "automationReadPoint.dispatchable",
          value: true,
        },
        {
          path: "automationReadPoint.selector",
          value: "heartbeat.xml",
        },
        {
          path: "automationReadPoint.xml",
          contains: "<message>next_safe=",
        },
        {
          path: "fallbackReason",
          value: null,
        },
        {
          path: "mode",
          value: "state_write",
        },
        {
          path: "freshness.status",
          value: "ok",
        },
        {
          path: "freshness.maxAgeMs",
          value: DMAD_HEARTBEAT_READBACK_MAX_AGE_MS,
        },
        {
          path: "readOnly",
          value: true,
        },
        {
          path: "safety.noExternalWrite",
          value: true,
        },
      ],
    },
  },
  {
    id: "state-capital-service-status-panel",
    label: "Capital API service status panel state",
    path: ".openclaw/quote/capital-service-status.json",
  },
  {
    id: "state-capital-telegram-owner-panel",
    label: "Capital API Telegram owner panel state",
    path: ".openclaw/quote/capital-telegram-owner-check.json",
  },
  {
    id: "skill-openclaw-card-framework-builder",
    label: "OpenClaw card framework builder skill",
    path: "skills/openclaw-card-framework-builder/SKILL.md",
  },
  {
    id: "skill-openclaw-okx-cex-status",
    label: "OpenClaw OKX CEX status skill",
    path: "skills/openclaw-okx-cex-status/SKILL.md",
  },
  {
    id: "skill-openclaw-global-source-audit",
    label: "OpenClaw global source audit skill",
    path: "skills/openclaw-global-source-audit/SKILL.md",
  },
  {
    id: "runtime-source-indexer",
    label: "Runtime source indexer anchor",
    path: "runtime/skills/source_indexer/source_indexer.py",
  },
  {
    id: "tengyi-401-pdf-skill",
    label: "Tengyi 401 PDF trainer skill",
    path: "skills/tengyi-401-pdf-autonomous-trainer/SKILL.md",
  },
];

const REQUIRED_MANIFESTS = [
  {
    id: "migrate-hermes-manifest",
    label: "migrate-hermes manifest",
    path: "extensions/migrate-hermes/openclaw.plugin.json",
  },
];

const REQUIRED_SKILL_METADATA = [
  {
    id: "skill-openclaw-card-framework-builder-criticality",
    label: "OpenClaw card framework builder criticality",
    path: "skills/openclaw-card-framework-builder/SKILL.md",
  },
  {
    id: "skill-tengyi-401-pdf-criticality",
    label: "Tengyi 401 PDF trainer criticality",
    path: "skills/tengyi-401-pdf-autonomous-trainer/SKILL.md",
  },
  {
    id: "skill-openclaw-global-source-audit-criticality",
    label: "OpenClaw global source audit criticality",
    path: "skills/openclaw-global-source-audit/SKILL.md",
  },
];

const CRITICALITY_LEVELS = new Set(["critical", "important", "optional", "experimental"]);

function toRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

async function readJsonFile(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

function isValidCriticality(value) {
  return typeof value === "string" && CRITICALITY_LEVELS.has(value);
}

function readManifestCriticality(manifest) {
  return manifest?.metadata?.openclaw?.criticality;
}

function readSkillCriticality(text) {
  const match = /^metadata:\s*(\{.*\})\s*$/m.exec(text);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    return JSON.parse(match[1])?.openclaw?.criticality;
  } catch {
    return undefined;
  }
}

function getJsonPathValue(value, dottedPath) {
  return String(dottedPath)
    .split(".")
    .filter(Boolean)
    .reduce((current, segment) => {
      if (current && typeof current === "object" && segment in current) {
        return current[segment];
      }
      return undefined;
    }, value);
}

function formatContractValue(value) {
  return value === undefined ? "<missing>" : JSON.stringify(value);
}

function hasContractKey(value, key) {
  return Object.prototype.hasOwnProperty.call(value ?? {}, key);
}

function formatRequiredJsonExpectation(required) {
  if (hasContractKey(required, "contains")) {
    return `string containing ${formatContractValue(required.contains)}`;
  }
  if (required.nonEmpty === true) {
    return "non-empty string";
  }
  return formatContractValue(required.value);
}

function formatRequiredJsonValueFailure(required, actual) {
  const pathLabel = required.path || "<missing-path>";
  const expectedText = formatRequiredJsonExpectation(required);
  if (actual === undefined) {
    return `missing JSON path "${pathLabel}" expected ${expectedText}`;
  }
  return `JSON path "${pathLabel}" expected ${expectedText} but got ${formatContractValue(actual)}`;
}

function validateGeneratedAtFreshness(value, expected, nowMs) {
  if (!Number.isFinite(expected.maxGeneratedAtAgeMs)) {
    return [];
  }
  const pathLabel = expected.generatedAtPath || "generatedAt";
  const actual = getJsonPathValue(value, pathLabel);
  const expectedText = `ISO timestamp age 0..${expected.maxGeneratedAtAgeMs}ms`;
  if (actual === undefined) {
    return [`missing JSON path "${pathLabel}" expected ${expectedText}`];
  }
  const timestampMs = Date.parse(actual);
  if (!Number.isFinite(timestampMs)) {
    return [
      `JSON path "${pathLabel}" expected ${expectedText} but got ${formatContractValue(actual)}`,
    ];
  }
  const ageMs = nowMs - timestampMs;
  if (ageMs < 0 || ageMs > expected.maxGeneratedAtAgeMs) {
    return [`JSON path "${pathLabel}" ageMs=${ageMs} expected 0..${expected.maxGeneratedAtAgeMs}`];
  }
  return [];
}

function validateJsonContract(value, expected, { nowMs = Date.now() } = {}) {
  const failures = [];
  if (expected.schema && value?.schema !== expected.schema) {
    failures.push(`schema=${value?.schema ?? "<missing>"}`);
  }
  if (expected.status && value?.status !== expected.status) {
    failures.push(`status=${value?.status ?? "<missing>"}`);
  }
  if (
    Array.isArray(expected.allowedStatuses) &&
    !expected.allowedStatuses.includes(value?.status)
  ) {
    failures.push(
      `status=${value?.status ?? "<missing>"} expected one of ${expected.allowedStatuses.join("|")}`,
    );
  }
  if (
    Number.isFinite(expected.summaryFailed) &&
    value?.summary?.failed !== expected.summaryFailed
  ) {
    failures.push(`summary.failed=${value?.summary?.failed ?? "<missing>"}`);
  }
  if (
    Number.isFinite(expected.minSummaryChecks) &&
    (!Number.isFinite(value?.summary?.checks) || value.summary.checks < expected.minSummaryChecks)
  ) {
    failures.push(`summary.checks=${value?.summary?.checks ?? "<missing>"}`);
  }
  if (
    Number.isFinite(expected.summaryShortcuts) &&
    value?.summary?.shortcuts !== expected.summaryShortcuts
  ) {
    failures.push(`summary.shortcuts=${value?.summary?.shortcuts ?? "<missing>"}`);
  }
  failures.push(...validateGeneratedAtFreshness(value, expected, nowMs));
  for (const required of expected.requiredJsonValues ?? []) {
    const actual = getJsonPathValue(value, required.path);
    if (required.nonEmpty === true) {
      if (typeof actual !== "string" || actual.trim().length === 0) {
        failures.push(formatRequiredJsonValueFailure(required, actual));
      }
      continue;
    }
    if (hasContractKey(required, "contains")) {
      if (typeof actual !== "string" || !actual.includes(required.contains)) {
        failures.push(formatRequiredJsonValueFailure(required, actual));
      }
      continue;
    }
    if (actual !== required.value) {
      failures.push(formatRequiredJsonValueFailure(required, actual));
    }
  }
  return failures;
}

function validateTextContract(value, expected) {
  const failures = [];
  for (const requiredText of expected.requiredIncludes ?? []) {
    if (typeof requiredText !== "string" || !value.includes(requiredText)) {
      failures.push(`missing text token ${formatContractValue(requiredText)}`);
    }
  }
  return failures;
}

async function resolveExistingPath(repoRoot, candidates) {
  for (const candidate of candidates) {
    const absolutePath = path.join(repoRoot, candidate);
    try {
      const stats = await fs.stat(absolutePath);
      if (stats.isDirectory()) {
        return { candidate, absolutePath };
      }
    } catch {
      // Continue.
    }
  }
  return undefined;
}

async function collectDirectoryChecks(repoRoot) {
  const checks = [];
  for (const entry of REQUIRED_DIRECTORIES) {
    const resolved = await resolveExistingPath(repoRoot, entry.candidates);
    checks.push({
      id: entry.id,
      label: entry.label,
      kind: "directory",
      required: entry.candidates,
      status: resolved ? "pass" : "fail",
      resolvedPath: resolved ? toRepoPath(path.relative(repoRoot, resolved.absolutePath)) : null,
      message: resolved
        ? `Found at ${toRepoPath(path.relative(repoRoot, resolved.absolutePath))}`
        : `Missing required directory candidates: ${entry.candidates.join(", ")}`,
    });
  }
  return checks;
}

async function collectFileChecks(repoRoot) {
  const checks = [];
  for (const entry of REQUIRED_FILES) {
    const absolutePath = path.join(repoRoot, entry.path);
    try {
      const stats = await fs.stat(absolutePath);
      if (!stats.isFile()) {
        checks.push({
          id: entry.id,
          label: entry.label,
          kind: "file",
          required: [entry.path],
          status: "fail",
          resolvedPath: null,
          message: "Path exists but is not a file",
        });
        continue;
      }
      if (entry.json) {
        const json = await readJsonFile(absolutePath);
        const contractFailures = validateJsonContract(json, entry.json);
        checks.push({
          id: entry.id,
          label: entry.label,
          kind: "file",
          required: [entry.path],
          status: contractFailures.length === 0 ? "pass" : "fail",
          resolvedPath: entry.path,
          message:
            contractFailures.length === 0
              ? "JSON contract is valid"
              : `JSON contract failed: ${contractFailures.join(", ")}`,
        });
        continue;
      }
      if (entry.text) {
        const text = await fs.readFile(absolutePath, "utf8");
        const contractFailures = validateTextContract(text, entry.text);
        checks.push({
          id: entry.id,
          label: entry.label,
          kind: "file",
          required: [entry.path],
          status: contractFailures.length === 0 ? "pass" : "fail",
          resolvedPath: entry.path,
          message:
            contractFailures.length === 0
              ? "Text contract is valid"
              : `Text contract failed: ${contractFailures.join(", ")}`,
        });
        continue;
      }
      checks.push({
        id: entry.id,
        label: entry.label,
        kind: "file",
        required: [entry.path],
        status: "pass",
        resolvedPath: entry.path,
        message: "Found",
      });
    } catch (error) {
      checks.push({
        id: entry.id,
        label: entry.label,
        kind: "file",
        required: [entry.path],
        status: "fail",
        resolvedPath: null,
        message: `Missing or invalid required file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }
  return checks;
}

async function collectManifestChecks(repoRoot) {
  const checks = [];
  for (const entry of REQUIRED_MANIFESTS) {
    const absolutePath = path.join(repoRoot, entry.path);
    try {
      const manifest = await readJsonFile(absolutePath);
      const providers = manifest?.contracts?.migrationProviders;
      const hasProvider = Array.isArray(providers) && providers.includes("hermes");
      const idMatches = manifest?.id === "migrate-hermes";
      const criticality = readManifestCriticality(manifest);
      if (!idMatches || !hasProvider || !isValidCriticality(criticality)) {
        checks.push({
          id: entry.id,
          label: entry.label,
          kind: "manifest",
          required: [entry.path],
          status: "fail",
          resolvedPath: entry.path,
          message:
            "Manifest must declare id=migrate-hermes, contracts.migrationProviders including hermes, and metadata.openclaw.criticality",
        });
      } else {
        checks.push({
          id: entry.id,
          label: entry.label,
          kind: "manifest",
          required: [entry.path],
          status: "pass",
          resolvedPath: entry.path,
          message: "Manifest contract is valid",
        });
      }
    } catch (error) {
      checks.push({
        id: entry.id,
        label: entry.label,
        kind: "manifest",
        required: [entry.path],
        status: "fail",
        resolvedPath: null,
        message: `Manifest read failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return checks;
}

async function collectSkillMetadataChecks(repoRoot) {
  const checks = [];
  for (const entry of REQUIRED_SKILL_METADATA) {
    const absolutePath = path.join(repoRoot, entry.path);
    try {
      const text = await fs.readFile(absolutePath, "utf8");
      const criticality = readSkillCriticality(text);
      checks.push({
        id: entry.id,
        label: entry.label,
        kind: "skill-metadata",
        required: [entry.path],
        status: isValidCriticality(criticality) ? "pass" : "fail",
        resolvedPath: entry.path,
        message: isValidCriticality(criticality)
          ? `Criticality metadata is valid: ${criticality}`
          : "Skill frontmatter must declare metadata.openclaw.criticality",
      });
    } catch (error) {
      checks.push({
        id: entry.id,
        label: entry.label,
        kind: "skill-metadata",
        required: [entry.path],
        status: "fail",
        resolvedPath: null,
        message: `Skill metadata read failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return checks;
}

function collectContractProbeChecks() {
  const probes = [
    {
      id: "contract-probe:json-required-path-message",
      label: "JSON contract required path negative probe",
      path: "summary.assistantClosure.statusStripFixtureCoverage.visibleInAssistantStatusStrip",
      value: true,
    },
    {
      id: "contract-probe:next-command-short-row-gate-verified-message",
      label: "Telegram next-command row gateVerified negative probe",
      path: "summary.assistantClosure.assistantLearningHint.nextCommandShortRow.gateVerified",
      value: true,
    },
    {
      id: "contract-probe:controlled-runner-next-safe-dmad-validation-command",
      label: "Controlled runner next-safe DMAD validation command negative probe",
      path: "dmad_validation_hint.command",
      contains: "pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full",
    },
    {
      id: "contract-probe:controlled-runner-next-safe-dmad-publish-machine-line",
      label: "Controlled runner next-safe DMAD publish status machine-line negative probe",
      path: "dmad_publish_status.machineLine",
      contains: "dmadPublish=",
    },
    {
      id: "contract-probe:controlled-runner-next-safe-dmad-publish-verified",
      label: "Controlled runner next-safe DMAD publish verified negative probe",
      path: "dmad_publish_status.verified",
      value: true,
    },
    {
      id: "contract-probe:controlled-runner-next-safe-dmad-publish-okx-contract",
      label: "Controlled runner next-safe DMAD publish OKX contract negative probe",
      path: "dmad_publish_status.upstreamOkxContractVerified",
      value: true,
    },
    {
      id: "contract-probe:controlled-runner-next-safe-dmad-publish-scheduler-next-run-at",
      label: "Controlled runner next-safe DMAD publish schedulerNextRunAt negative probe",
      path: "dmad_publish_status.upstreamSchedulerNextRunAt",
      nonEmpty: true,
    },
    {
      id: "contract-probe:controlled-runner-trading-readiness-machine-line",
      label: "Controlled runner trading readiness machine-line negative probe",
      path: "trading_readiness_status.machineLine",
      contains: "tradingReadiness=quote:",
    },
    {
      id: "contract-probe:controlled-runner-trading-readiness-zh-tw",
      label: "Controlled runner trading readiness zh-TW negative probe",
      path: "trading_readiness_status_zh_tw",
      contains: "交易就緒=報價:",
    },
    {
      id: "contract-probe:controlled-runner-next-safe-machine-line-dmad-publish",
      label: "Controlled runner next-safe machine-line DMAD publish negative probe",
      path: "machineLine",
      contains: "dmadPublish=",
    },
    {
      id: "contract-probe:dmad-heartbeat-readback-fallback-reason-null",
      label: "DMAD heartbeat readback fallbackReason null negative probe",
      path: "fallbackReason",
      value: null,
    },
    {
      id: "contract-probe:dmad-heartbeat-readback-next-safe-non-empty",
      label: "DMAD heartbeat readback nextSafe non-empty negative probe",
      path: "nextSafe",
      nonEmpty: true,
    },
    {
      id: "contract-probe:dmad-heartbeat-readback-message-next-safe",
      label: "DMAD heartbeat readback message next_safe negative probe",
      path: "heartbeat.message",
      contains: "next_safe=",
    },
    {
      id: "contract-probe:dmad-heartbeat-readback-xml-next-safe",
      label: "DMAD heartbeat readback XML next_safe negative probe",
      path: "heartbeat.xml",
      contains: "<message>next_safe=",
    },
    {
      id: "contract-probe:dmad-heartbeat-readpoint-next-safe",
      label: "DMAD heartbeat readpoint nextSafe negative probe",
      path: "automationReadPoint.nextSafe",
      nonEmpty: true,
    },
    {
      id: "contract-probe:dmad-heartbeat-readpoint-stdout-free",
      label: "DMAD heartbeat readpoint stdout-free negative probe",
      path: "automationReadPoint.stdoutRequired",
      value: false,
    },
    {
      id: "contract-probe:dmad-heartbeat-readpoint-dispatchable",
      label: "DMAD heartbeat readpoint dispatchable negative probe",
      path: "automationReadPoint.dispatchable",
      value: true,
    },
    {
      id: "contract-probe:controlled-telegram-next-command-machine-line-message",
      label: "Controlled runner Telegram nextCommand machine line negative probe",
      path: "telegram_trading_shortcuts.nextCommandMachineLine",
      contains: "nextCommandShortRow=",
    },
    {
      id: "contract-probe:controlled-telegram-summary-okx-heartbeat-refresh",
      label: "Controlled runner Telegram summary OKX heartbeat refresh negative probe",
      path: "telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine",
      contains: "okxHeartbeatRefresh=",
    },
    {
      id: "contract-probe:controlled-telegram-summary-okx-heartbeat-execute-required",
      label: "Controlled runner Telegram summary OKX heartbeat executeRequired negative probe",
      path: "telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine",
      contains: "executeRequired=",
    },
    {
      id: "contract-probe:controlled-telegram-summary-okx-heartbeat-scheduler-next-run-at",
      label: "Controlled runner Telegram summary OKX heartbeat schedulerNextRunAt negative probe",
      path: "telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine",
      contains: "schedulerNextRunAt=",
    },
    {
      id: "contract-probe:controlled-telegram-summary-okx-heartbeat-no-order-write",
      label: "Controlled runner Telegram summary OKX heartbeat noOrderWrite negative probe",
      path: "telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine",
      contains: "noOrderWrite=true",
    },
    {
      id: "contract-probe:controlled-telegram-summary-capital-failed-replay-history",
      label: "Controlled runner Telegram summary Capital failed replay history negative probe",
      path: "telegram_trading_shortcuts.capitalFailedReplayHistoryMachineLine",
      contains: "capitalFailedReplayHistory=banned:",
    },
    {
      id: "contract-probe:controlled-telegram-summary-capital-failed-replay-next",
      label:
        "Controlled runner Telegram summary Capital failed replay next candidate negative probe",
      path: "telegram_trading_shortcuts.capitalFailedReplayHistoryMachineLine",
      contains: "next=",
    },
    {
      id: "contract-probe:controlled-telegram-summary-capital-failed-replay-no-order-write",
      label: "Controlled runner Telegram summary Capital failed replay noOrderWrite negative probe",
      path: "telegram_trading_shortcuts.capitalFailedReplayHistoryMachineLine",
      contains: "noOrderWrite=true",
    },
    {
      id: "contract-probe:telegram-summary-okx-scheduler-no-order-contract",
      label: "Telegram shortcuts OKX scheduler/noOrderWrite contract negative probe",
      path: "summary.okxSchedulerNoOrderContractProbeClosure.machineLine",
      contains: "okxSchedulerNoOrderContract=pass reports=3/3 schedulerNextRunAt=",
    },
    {
      id: "contract-probe:controlled-telegram-publish-message-next-command",
      label: "Controlled runner Telegram publish message nextCommand negative probe",
      path: "message",
      contains: "下一步指令=nextCommandShortRow=",
    },
    {
      id: "contract-probe:controlled-telegram-publish-message-tradingagents",
      label: "Controlled runner Telegram publish message TradingAgents negative probe",
      path: "message",
      contains: "TradingAgents=tradingAgents=",
    },
    {
      id: "contract-probe:controlled-telegram-publish-message-tradingagents-no-live-order",
      label:
        "Controlled runner Telegram publish message TradingAgents no-live-order negative probe",
      path: "message",
      contains: "noLiveOrderSent=true",
    },
    {
      id: "contract-probe:controlled-telegram-publish-message-receipt-prompt",
      label: "Controlled runner Telegram publish message receipt prompt negative probe",
      path: "message",
      contains: "回關收據命令=receiptPrompt=",
    },
    {
      id: "contract-probe:controlled-telegram-publish-message-capital-operator-packet",
      label: "Controlled runner Telegram publish message Capital operator packet negative probe",
      path: "message",
      contains: "真單Packet=capitalOperatorPacket=",
    },
    {
      id: "contract-probe:controlled-telegram-publish-message-capital-operator-can-execute",
      label:
        "Controlled runner Telegram publish message Capital operator can-execute negative probe",
      path: "message",
      contains: "operatorCanExecute=false",
    },
    {
      id: "contract-probe:controlled-telegram-publish-message-capital-operator-apply-receipt",
      label:
        "Controlled runner Telegram publish message Capital operator apply receipt negative probe",
      path: "message",
      contains: "adapterApplyReceipt=",
    },
    {
      id: "contract-probe:controlled-telegram-publish-message-capital-operator-apply-receipt-verified",
      label:
        "Controlled runner Telegram publish message Capital operator apply receipt verified negative probe",
      path: "message",
      contains: "adapterApplyReceiptVerified=",
    },
    {
      id: "contract-probe:controlled-telegram-publish-message-position-snapshot",
      label: "Controlled runner Telegram publish message Capital position snapshot negative probe",
      path: "message",
      contains: "倉位快照=capitalVerifiedPositionSnapshot=",
    },
    {
      id: "contract-probe:controlled-telegram-publish-message-okx-refresh",
      label: "Controlled runner Telegram publish message OKX refresh negative probe",
      path: "message",
      contains: "OKX刷新=okxCurrentReadinessRefresh=",
    },
    {
      id: "contract-probe:controlled-telegram-publish-message-okx-heartbeat-refresh",
      label: "Controlled runner Telegram publish message OKX heartbeat refresh negative probe",
      path: "message",
      contains: "OKX心跳=okxHeartbeatRefresh=",
    },
    {
      id: "contract-probe:controlled-telegram-publish-message-okx-heartbeat-execute-required",
      label:
        "Controlled runner Telegram publish message OKX heartbeat executeRequired negative probe",
      path: "message",
      contains: "executeRequired=",
    },
    {
      id: "contract-probe:controlled-telegram-publish-message-okx-heartbeat-scheduler-next-run-at",
      label:
        "Controlled runner Telegram publish message OKX heartbeat schedulerNextRunAt negative probe",
      path: "message",
      contains: "schedulerNextRunAt=",
    },
    {
      id: "contract-probe:controlled-telegram-publish-message-no-order-write",
      label: "Controlled runner Telegram publish message noOrderWrite negative probe",
      path: "message",
      contains: "noOrderWrite=true",
    },
    {
      id: "contract-probe:controlled-telegram-publish-token-summary-okx-refresh",
      label: "Controlled runner Telegram publish token summary OKX refresh negative probe",
      path: "messageTokenCountsSummaryZhTw",
      contains: "OKX刷新=1",
    },
    {
      id: "contract-probe:controlled-telegram-publish-token-summary-okx-heartbeat",
      label: "Controlled runner Telegram publish token summary OKX heartbeat negative probe",
      path: "messageTokenCountsSummaryZhTw",
      contains: "OKX心跳=1",
    },
    {
      id: "contract-probe:controlled-telegram-publish-token-summary-okx-contract",
      label: "Controlled runner Telegram publish token summary OKX contract negative probe",
      path: "messageTokenCountsSummaryZhTw",
      contains: "OKX合約=1",
    },
    {
      id: "contract-probe:controlled-telegram-publish-token-summary-position-snapshot",
      label: "Controlled runner Telegram publish token summary position snapshot negative probe",
      path: "messageTokenCountsSummaryZhTw",
      contains: "倉位快照=1",
    },
    {
      id: "contract-probe:controlled-telegram-publish-token-summary-tradingagents",
      label: "Controlled runner Telegram publish token summary TradingAgents negative probe",
      path: "messageTokenCountsSummaryZhTw",
      contains: "TradingAgents=1",
    },
    {
      id: "contract-probe:controlled-telegram-publish-token-summary-receipt-prompt",
      label: "Controlled runner Telegram publish token summary receipt prompt negative probe",
      path: "messageTokenCountsSummaryZhTw",
      contains: "回關收據命令=1",
    },
    {
      id: "contract-probe:controlled-telegram-publish-token-summary-no-order-write",
      label: "Controlled runner Telegram publish token summary noOrderWrite negative probe",
      path: "messageTokenCountsSummaryZhTw",
      contains: "noOrderWrite=true=4",
    },
    {
      id: "contract-probe:controlled-telegram-publish-token-summary-local-executor",
      label: "Controlled runner Telegram publish token summary local executor negative probe",
      path: "messageTokenCountsSummaryZhTw",
      contains: "本地執行器=1",
    },
    {
      id: "contract-probe:controlled-telegram-publish-token-summary-dmad-gate",
      label: "Controlled runner Telegram publish token summary DMAD gate negative probe",
      path: "messageTokenCountsSummaryZhTw",
      contains: "DMAD=1",
    },
    {
      id: "contract-probe:controlled-telegram-publish-token-count-no-order-write",
      label: "Controlled runner Telegram publish token count noOrderWrite negative probe",
      path: "messageTokenCounts.noOrderWrite",
      value: 4,
    },
    {
      id: "contract-probe:controlled-telegram-publish-token-count-local-executor",
      label: "Controlled runner Telegram publish token count local executor negative probe",
      path: "messageTokenCounts.localExecutorDispatch",
      value: 1,
    },
    {
      id: "contract-probe:controlled-telegram-publish-token-count-position-snapshot",
      label: "Controlled runner Telegram publish token count position snapshot negative probe",
      path: "messageTokenCounts.positionSnapshot",
      value: 1,
    },
    {
      id: "contract-probe:controlled-telegram-publish-token-count-tradingagents",
      label: "Controlled runner Telegram publish token count TradingAgents negative probe",
      path: "messageTokenCounts.tradingAgents",
      value: 1,
    },
    {
      id: "contract-probe:controlled-telegram-publish-token-count-receipt-prompt",
      label: "Controlled runner Telegram publish token count receipt prompt negative probe",
      path: "messageTokenCounts.receiptPrompt",
      value: 1,
    },
    {
      id: "contract-probe:controlled-telegram-publish-token-count-okx-contract",
      label: "Controlled runner Telegram publish token count OKX contract negative probe",
      path: "messageTokenCounts.okxContract",
      value: 1,
    },
    {
      id: "contract-probe:controlled-telegram-publish-token-count-dmad-gate",
      label: "Controlled runner Telegram publish token count DMAD gate negative probe",
      path: "messageTokenCounts.dmadGate",
      value: 1,
    },
  ];

  const requiredPathChecks = probes.map((probe) => {
    const requiredJsonValue =
      probe.nonEmpty === true
        ? {
            path: probe.path,
            nonEmpty: true,
          }
        : hasContractKey(probe, "contains")
          ? {
              path: probe.path,
              contains: probe.contains,
            }
          : {
              path: probe.path,
              value: probe.value,
            };
    const failures = validateJsonContract(
      {},
      {
        requiredJsonValues: [requiredJsonValue],
      },
    );
    const expectedMessage = `missing JSON path "${probe.path}" expected ${formatRequiredJsonExpectation(requiredJsonValue)}`;
    return {
      id: probe.id,
      label: probe.label,
      kind: "contract-probe",
      required: [probe.path],
      status: failures.includes(expectedMessage) ? "pass" : "fail",
      resolvedPath: null,
      message: failures[0] ?? "Missing expected contract failure",
    };
  });

  const freshnessFailures = validateJsonContract(
    {
      generatedAt: "2026-05-25T00:00:00.000Z",
    },
    {
      generatedAtPath: "generatedAt",
      maxGeneratedAtAgeMs: 1000,
    },
    {
      nowMs: Date.parse("2026-05-25T00:00:02.000Z"),
    },
  );
  const freshnessMessage = 'JSON path "generatedAt" ageMs=2000 expected 0..1000';
  const nonEmptyFailures = validateJsonContract(
    { nextSafe: "" },
    { requiredJsonValues: [{ path: "nextSafe", nonEmpty: true }] },
  );
  const nonEmptyMessage = 'JSON path "nextSafe" expected non-empty string but got ""';
  return [
    ...requiredPathChecks,
    {
      id: "contract-probe:json-non-empty-message",
      label: "JSON contract non-empty string negative probe",
      kind: "contract-probe",
      required: ["nextSafe"],
      status: nonEmptyFailures.includes(nonEmptyMessage) ? "pass" : "fail",
      resolvedPath: null,
      message: nonEmptyFailures[0] ?? "Missing expected non-empty failure",
    },
    {
      id: "contract-probe:dmad-heartbeat-readback-generated-at-freshness",
      label: "DMAD heartbeat readback generatedAt freshness negative probe",
      kind: "contract-probe",
      required: ["generatedAt"],
      status: freshnessFailures.includes(freshnessMessage) ? "pass" : "fail",
      resolvedPath: null,
      message: freshnessFailures[0] ?? "Missing expected freshness failure",
    },
  ];
}

function summarizeChecks(checks) {
  const total = checks.length;
  const passed = checks.filter((entry) => entry.status === "pass").length;
  const failed = total - passed;
  return {
    total,
    passed,
    failed,
    ok: failed === 0,
  };
}

function formatHumanReport(report) {
  const lines = [
    "OpenClaw autonomous inventory",
    `Repo: ${report.repoRoot}`,
    `Summary: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed`,
  ];

  for (const check of report.checks) {
    const mark = check.status === "pass" ? "[PASS]" : "[FAIL]";
    lines.push(`${mark} ${check.kind}:${check.id} - ${check.message}`);
  }

  return lines.join("\n");
}

export async function collectAutonomousInventory(repoRoot = process.cwd()) {
  const normalizedRoot = path.resolve(repoRoot);
  const checks = [
    ...(await collectDirectoryChecks(normalizedRoot)),
    ...(await collectFileChecks(normalizedRoot)),
    ...(await collectManifestChecks(normalizedRoot)),
    ...(await collectSkillMetadataChecks(normalizedRoot)),
    ...collectContractProbeChecks(),
  ];
  return {
    repoRoot: toRepoPath(normalizedRoot),
    generatedAt: new Date().toISOString(),
    checks,
    summary: summarizeChecks(checks),
  };
}

export async function runAutonomousInventoryCheck({
  argv = process.argv.slice(2),
  io = { stdout: process.stdout, stderr: process.stderr },
  repoRoot = process.cwd(),
} = {}) {
  const checkMode = argv.includes("--check");
  const jsonMode = argv.includes("--json");
  const report = await collectAutonomousInventory(repoRoot);

  if (jsonMode) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.stdout.write(`${formatHumanReport(report)}\n`);
  }

  if (!checkMode) {
    return 0;
  }

  if (report.summary.ok) {
    io.stdout.write("autonomous inventory check passed\n");
    return 0;
  }

  io.stderr.write("autonomous inventory check failed\n");
  for (const check of report.checks) {
    if (check.status !== "fail") {
      continue;
    }
    io.stderr.write(`- ${check.kind}:${check.id} (${check.required.join(" | ")})\n`);
  }
  return 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = fileURLToPath(import.meta.url);
if (invokedPath === currentPath) {
  runAutonomousInventoryCheck()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        `autonomous inventory check crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
