---
summary: "Tracks core module and skill inventory checkpoints used by autonomous gate validation."
read_when:
  - You need to confirm the module and skill surfaces required by autonomous workflows
  - You are troubleshooting autonomous inventory failures
title: "Module Skill Inventory"
---

# Module Skill Inventory

The autonomous inventory gate validates these required surfaces:

| Scope                                 | Required path candidates                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Agent skills                          | `.agents/skills`                                                                                             |
| Workspace skills                      | `skills`                                                                                                     |
| Bundled plugins                       | `extensions`                                                                                                 |
| Hooks                                 | `hooks` or `src/hooks`                                                                                       |
| Cron                                  | `cron` or `src/cron`                                                                                         |
| Gateway                               | `gateway` or `src/gateway`                                                                                   |
| Runtime                               | `runtime` or `src/runtime`                                                                                   |
| Cron direct runner                    | `scripts/openclaw-cron-direct-runner.mjs`                                                                    |
| Post-cron learner hook                | `extensions/evolution-learning/hooks/post-cron-learner.js`                                                   |
| Controlled paths check                | `scripts/check-openclaw-controlled-paths.mjs`                                                                |
| Controlled runner latest              | `reports/hermes-agent/state/openclaw-controlled-task-runner-latest.json`                                     |
| JSON contract negative probe          | `scripts/openclaw-autonomous-inventory.mjs#collectContractProbeChecks`                                       |
| Minimal runtime profile               | `config/openclaw-minimal-runtime-profile.json`                                                               |
| Minimal runtime check                 | `scripts/check-openclaw-minimal-runtime-profile.mjs`                                                         |
| Capital active-page plan              | `scripts/openclaw-capital-active-page-refresh-plan.mjs`                                                      |
| Capital active-page check             | `scripts/check-capital-active-page-refresh-plan.mjs`                                                         |
| Capital active-page report            | `reports/hermes-agent/state/openclaw-capital-active-page-refresh-plan-latest.json`                           |
| Capital core product matrix           | `scripts/openclaw-capital-core-product-freshness-matrix.mjs`                                                 |
| Capital core matrix check             | `scripts/check-capital-core-product-freshness-matrix.mjs`                                                    |
| Capital core matrix report            | `.openclaw/quote/capital-core-product-freshness-matrix.json`                                                 |
| Capital direct status                 | `scripts/openclaw-capital-direct-operation-status.mjs`                                                       |
| Capital direct status check           | `scripts/check-capital-direct-operation-status.mjs`                                                          |
| Capital direct status rpt             | `reports/hermes-agent/state/openclaw-capital-direct-operation-status-latest.json`                            |
| Capital position refresh              | `scripts/openclaw-capital-position-snapshot-refresh-gate.mjs`                                                |
| Capital position refresh chk          | `scripts/check-capital-position-snapshot-refresh-gate.mjs`                                                   |
| Capital position refresh rpt          | `reports/hermes-agent/state/openclaw-capital-position-snapshot-refresh-gate-latest.json`                     |
| Capital direct inputs                 | `scripts/openclaw-capital-direct-operation-inputs.mjs`                                                       |
| Capital direct inputs check           | `scripts/check-capital-direct-operation-inputs.mjs`                                                          |
| Capital direct inputs rpt             | `reports/hermes-agent/state/openclaw-capital-direct-operation-inputs-latest.json`                            |
| Capital strategy platform             | `scripts/openclaw-capital-direct-strategy-platform-gate.mjs`                                                 |
| Capital strategy platform chk         | `scripts/check-capital-direct-strategy-platform-gate.mjs`                                                    |
| Capital strategy platform rpt         | `reports/hermes-agent/state/openclaw-capital-direct-strategy-platform-gate-latest.json`                      |
| Capital equity sizer check            | `scripts/check-capital-strategy-equity-position-sizer.mjs`                                                   |
| Capital high-conf rerun               | `scripts/openclaw-capital-high-confidence-paper-rerun-gate.mjs`                                              |
| Capital high-conf rerun chk           | `scripts/check-capital-high-confidence-paper-rerun-gate.mjs`                                                 |
| Capital high-conf rerun rpt           | `reports/hermes-agent/state/openclaw-capital-high-confidence-paper-rerun-gate-latest.json`                   |
| Capital micro rerun                   | `scripts/openclaw-capital-micro-alternative-paper-rerun-gate.mjs`                                            |
| Capital micro rerun chk               | `scripts/check-capital-micro-alternative-paper-rerun-gate.mjs`                                               |
| Capital micro rerun rpt               | `reports/hermes-agent/state/openclaw-capital-micro-alternative-paper-rerun-gate-latest.json`                 |
| Capital risk-resized rerun            | `scripts/openclaw-capital-risk-resized-paper-intent-rerun-gate.mjs`                                          |
| Capital risk-resized chk              | `scripts/check-capital-risk-resized-paper-intent-rerun-gate.mjs`                                             |
| Capital risk-resized rpt              | `reports/hermes-agent/state/openclaw-capital-risk-resized-paper-intent-rerun-gate-latest.json`               |
| Capital current paper intents         | `scripts/openclaw-capital-current-paper-intents-from-target-registry.mjs`                                    |
| Capital current intents check         | `scripts/check-capital-current-paper-intents-from-target-registry.mjs`                                       |
| Capital current intents rpt           | `reports/hermes-agent/state/openclaw-capital-current-paper-intents-from-target-registry-latest.json`         |
| Capital live readiness sim            | `scripts/openclaw-capital-live-readiness-simulation.mjs`                                                     |
| Capital live readiness check          | `scripts/check-capital-live-readiness-simulation.mjs`                                                        |
| Capital live readiness rpt            | `reports/hermes-agent/state/openclaw-capital-live-readiness-simulation-latest.json`                          |
| Capital auto-deactivate receipt gate  | `scripts/openclaw-capital-live-trading-operator-auto-deactivate-receipt-gate.mjs`                            |
| Capital auto-deactivate receipt check | `scripts/check-capital-live-trading-operator-auto-deactivate-receipt-gate.mjs`                               |
| Capital auto-deactivate receipt rpt   | `reports/hermes-agent/state/openclaw-capital-live-trading-operator-auto-deactivate-receipt-gate-latest.json` |
| Capital ack apply receipt             | `scripts/openclaw-capital-adapter-ack-operator-apply-receipt-gate.mjs`                                       |
| Capital ack receipt check             | `scripts/check-capital-adapter-ack-operator-apply-receipt-gate.mjs`                                          |
| Capital ack receipt rpt               | `reports/hermes-agent/state/openclaw-capital-adapter-ack-operator-apply-receipt-gate-latest.json`            |
| Controlled watch runner               | `scripts/openclaw-controlled-task-runner-watch.mjs`                                                          |
| Controlled watch check                | `scripts/check-openclaw-controlled-task-runner-watch.mjs`                                                    |
| Blackbox autonomy tick                | `scripts/openclaw-blackbox-autonomy-tick.mjs`                                                                |
| Blackbox sync bridge                  | `scripts/openclaw-blackbox-sync-bridge.mjs`                                                                  |
| Blackbox autonomy check               | `scripts/check-openclaw-blackbox-autonomy.mjs`                                                               |
| Blackbox autonomy config              | `config/openclaw-blackbox-autonomy.json`                                                                     |
| Blackbox autonomy report              | `reports/hermes-agent/state/openclaw-blackbox-autonomy-latest.json`                                          |
| Blackbox sync report                  | `reports/hermes-agent/state/openclaw-blackbox-sync-latest.json`                                              |
| Evolution learning gate               | `scripts/check-openclaw-evolution-learning-architecture.mjs`                                                 |
| Card framework gate                   | `scripts/check-openclaw-card-framework.mjs`                                                                  |
| Card graph export                     | `scripts/export-openclaw-card-framework-graph.mjs`                                                           |
| Card module generator                 | `scripts/generate-openclaw-card-module-dry-run.mjs`                                                          |
| Card viewer render                    | `scripts/render-openclaw-card-framework-viewer.mjs`                                                          |
| Card framework registry               | `reports/openclaw-card-framework-cards.json`                                                                 |
| Card framework graph                  | `reports/openclaw-card-framework-graph.json`                                                                 |
| Card framework viewer                 | `reports/openclaw-card-framework-3d-viewer.html`                                                             |
| Card generator dry-run                | `reports/openclaw-card-module-generator-dry-run-latest.json`                                                 |
| Source watch generator                | `scripts/openclaw-source-watch-registry.mjs`                                                                 |
| Source watch check                    | `scripts/check-openclaw-source-watch-registry.mjs`                                                           |
| Source watch registry                 | `reports/openclaw-source-watch-registry-latest.json`                                                         |
| Resolver candidates                   | `scripts/openclaw-resolver-candidates.mjs`                                                                   |
| Resolver candidate check              | `scripts/check-openclaw-resolver-candidates.mjs`                                                             |
| Resolver candidate report             | `reports/openclaw-resolver-candidates-latest.json`                                                           |
| Resolver evidence lock                | `scripts/openclaw-resolver-evidence-lock.mjs`                                                                |
| Resolver evidence check               | `scripts/check-openclaw-resolver-evidence-lock.mjs`                                                          |
| Resolver evidence report              | `reports/hermes-agent/state/openclaw-controlled-task-runner-evidence-lock-latest.json`                       |
| Controlled Telegram summary           | `reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-latest.json`                            |
| Controlled Telegram markdown          | `reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-latest.md`                              |
| Controlled Telegram publish           | `reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-publish-latest.json`                    |
| DMAD heartbeat readback               | `scripts/dmad-heartbeat-next-safe-readback.mjs`                                                              |
| DMAD heartbeat readback chk           | `scripts/check-dmad-heartbeat-next-safe-readback.mjs`                                                        |
| Resolution workflow                   | `scripts/openclaw-resolution-workflow.mjs`                                                                   |
| Resolution workflow check             | `scripts/check-openclaw-resolution-workflow.mjs`                                                             |
| Resolution workflow report            | `reports/openclaw-resolution-workflow-latest.json`                                                           |
| Resolution workflow checklist         | `reports/openclaw-resolution-workflow-checklist.md`                                                          |
| Weak-signal intake gate               | `scripts/openclaw-weak-signal-intake-gate.mjs`                                                               |
| Weak-signal intake check              | `scripts/check-openclaw-weak-signal-intake-gate.mjs`                                                         |
| Weak-signal intake report             | `reports/openclaw-weak-signal-intake-gate-latest.json`                                                       |
| Card framework builder                | `skills/openclaw-card-framework-builder/SKILL.md`                                                            |
| OKX CEX status skill                  | `skills/openclaw-okx-cex-status/SKILL.md`                                                                    |
| Global source audit skill             | `skills/openclaw-global-source-audit/SKILL.md`                                                               |
| OKX CEX API status gate               | `scripts/openclaw-okx-api-status-gate.mjs`                                                                   |
| OKX CEX market loop gate              | `scripts/openclaw-okx-market-snapshot-loop.mjs`                                                              |
| OKX CEX market snapshot gate          | `scripts/openclaw-okx-market-snapshot-gate.mjs`                                                              |
| OKX CEX snapshot scheduler            | `scripts/openclaw-okx-market-snapshot-scheduler.mjs`                                                         |
| OKX CEX paper signal gate             | `scripts/openclaw-okx-paper-signal-gate.mjs`                                                                 |
| OKX CEX order proposal gate           | `scripts/openclaw-okx-order-proposal-gate.mjs`                                                               |
| OKX CEX order status gate             | `scripts/openclaw-okx-order-status-gate.mjs`                                                                 |
| Runtime anchor                        | `runtime/skills/source_indexer/source_indexer.py`                                                            |

Capital direct inputs must stay template-only: the active position snapshot and active broker adapter ack are operator-owned files, while OpenClaw may generate `capital-external-broker-adapter-ack.required-current.json`, `capital-external-broker-adapter-ack.staged-current.json`, and expected/actual sealed intent hash evidence for Telegram and gate reports. Direct inputs must expose `operatorReviews.externalBrokerAdapterAckRefresh` with active/staged/destination paths, expected/actual/candidate hashes, canary `sentOrder=false`, rollback freshness, active-write suppression, allowed writer, handoff checklist, and repo-root qualified validation commands. Adapter ack reports must expose canary `sentOrder=false`, rollback freshness evidence, and staged candidates carrying the concrete rollback `verifiedAt` from the active operator ack rather than placeholders, direct status reports must expose verified position snapshot `verifiedAt`, age, max freshness, and freshness status, and the strategy platform gate must expose `liveCompletion` stages for quote, position, strategy, adapter ack, canary, rollback, pretrade, and operator packet readiness so Telegram/OpenClaw can show whether the flow is executable evidence without writing active broker files.

Capital strategy tail-risk repair reports must expose `repairCandidatePlan` with paper-only candidate buckets for low-correlation/opposite exposure, contract point-value backfill, risk-notional review, selected signal confidence, empirical stop-hit calibration, and same-case rerun evidence. The plan is advisory and must keep `noOrderWrite=true`; it may guide Telegram/OpenClaw next actions but must not relax strategy promotion or send broker orders.

Capital risk-resized paper rerun reports must read the tail-risk repair risk-notional review plan, regenerate separate paper-only intents under `.openclaw/trading/capital-risk-resized-paper-rerun/`, rerun strategy fill simulation against those temporary intents, and expose pass/block status without overwriting active paper intents or sending broker orders. When pass count is zero, the report must also expose `rejectionSummary` with rejected symbols, p05 point/notional reasons, required pass conditions, and `noOrderWrite=true`.

Capital live readiness simulation reports must merge the latest direct status, strategy platform gate, adapter ack, adapter apply receipt, live executor arm profile, operator packet, local executor dispatch contract, TradingAgents summary, and risk-resized rerun evidence into 500 deterministic report-only simulations. The report lists every incomplete live-order gate, the method to complete it, and its validation command while keeping `noLiveOrderSent=true`, `sentOrder=false`, `writeBrokerOrders=false`, and `allowLiveTrading=false`; when apply receipt is pending, readiness must route to `pnpm capital:trade:adapter-ack-apply-receipt:check`.

Capital position snapshot refresh gates must treat `config/capital-verified-position-snapshot.json` as operator-owned active state. The gate may generate only a staged refresh candidate under `.openclaw/trading/staging/`, must expose verified age/max freshness, active-write suppression, allowed writer, and repo-root validation commands, and must keep `sentOrder=false`, `noLiveOrderSent=true`, `writeBrokerOrders=false`, and `wroteActiveSnapshot=false`.

Capital live executor arm profile reports must keep active profile writes operator-managed only. They must expose a staged re-arm candidate, active/staged profile paths, max 15 minute TTL evidence, active-write suppression, allowed writer, post-rearm live-readiness validation, and repo-root qualified handoff checklist commands while keeping `sentOrder=false` and `brokerWriteAttempted=false`.

Capital live pretrade handoff reports must keep sealed order intent output read-only and suppress broker command writes. When an operator-owned external adapter ack exists, its handoff template must carry the concrete rollback `verifiedAt` from the active ack instead of a placeholder, so the adapter ack gate, direct pretrade gate, and live-readiness aggregation agree on the same rollback evidence before any operator-owned refresh.

Capital live operator execution packets must preserve the adapter ack refresh plan's concrete `candidateRollbackVerifiedAt` in both `adapterAck.refreshPlan` and the ordered `adapter_ack_hash` blocker action, and must expose `adapterAck.applyReceipt` from the operator apply receipt gate. The packet remains report-only and must not mark `operatorCanExecute=true` until readiness, active ack hash, adapter apply receipt, direct pretrade, and live executor arm gates all pass.

Capital local broker executor dispatch contracts must also project the operator packet's adapter ack refresh plan, including `candidateRollbackVerifiedAt`, into report-only dispatch evidence. Dispatch stays `blocked_do_not_send` until the operator packet is executable and the local executor arm profile is fresh.

Capital adapter ack hash handoff verifier reports must stay report-only, compare active/staged ack hashes, preserve concrete `candidateRollbackVerifiedAt`, expose repo-root validation commands, suppress active ack writes, and keep `noLiveOrderSent=true` while marking only operator-owned adapter refresh as eligible.

Capital adapter ack refresh packets must convert the verified handoff into an operator-adapter-consumable atomic apply packet with source/destination paths, backup path, active/candidate content hashes, concrete rollback evidence, and repo-root validation commands. Packet generation is report-only: it must not write the active ack and must keep `noLiveOrderSent=true`.

Capital adapter ack operator apply verifier reports must read the refresh packet and active ack, distinguish `pre_apply_current_matches` from `applied_candidate_matches`, and expose whether the operator-owned adapter may apply or has already applied the packet. The verifier is report-only and must never write active ack or broker orders.

Capital adapter ack operator apply plans must turn a ready apply verifier into a dry-run-only atomic plan with destination/current hash verification, source/candidate hash verification, backup path, temp path, atomic replace step, and post-apply adapter/live-readiness validation commands. The plan must remain report-only and must not write backup, temp, active ack, or broker orders.

Capital adapter ack operator apply receipt gates must merge the apply verifier and apply plan into a single operator-visible receipt. The receipt must distinguish `pending_operator_apply` from `applied_receipt_verified`, expose source/destination/backup/temp paths, current/candidate hashes, repo-root validation commands, and keep `sentOrder=false`, `noLiveOrderSent=true`, `writeBrokerOrders=false`, and all active ack writes suppressed.

Capital post-apply live closure gates must merge the operator apply verifier, apply plan, apply receipt, live-readiness simulation, and local executor dispatch contract after the operator-owned adapter applies the candidate ack. The gate may only report whether adapter apply receipt, adapter apply, live readiness, and local executor final-confirmation dispatch are all ready; it must keep `sentOrder=false`, `noLiveOrderSent=true`, `writeBrokerOrders=false`, and all validation commands repo-root qualified.

Capital live readiness simulation must refresh and read the Capital core product freshness matrix first. The matrix is the all-product quote gate for the core domestic/overseas universe; readiness reports must expose `quoteFreshness.coreProductMatrix`, require `sourceReports.coreProductMatrix.found=true`, and route the next task to `pnpm capital:quote:core-products:check` before narrower A50, strategy, adapter, or executor gates.

Capital service status reports must keep `safety.allowLiveTrading=false`, `safety.writeBrokerOrders=false`, and `safety.realOrderAllowed=false` because the report itself is read-only. If the external `risk-controls.json` currently has live/write flags enabled, the report must expose those under `riskControlsObserved` as report-only blocker evidence instead of marking the OpenClaw status report as broker-write capable.

The controlled task runner must treat `riskControlsObserved.allowLiveTrading=true` or `riskControlsObserved.writeBrokerOrders=true` as `capital_risk_controls_live_write_observed` and route the next safe task to the report-only `pnpm capital:live-trading:operator:auto-deactivate` command. It must not execute `auto-deactivate:execute` from the heartbeat/runner path.

Capital auto-deactivate receipt gate is report-only: dry-run status may be `pending_explicit_execute_receipt` when `operatorActionAuditId` exists but `operatorActionReceipt` is not present yet. It must keep `heartbeatExecuteAllowed=false`, `sentOrder=false`, `writeBrokerOrders=false`, and `safety.noLiveOrderSent=true`; only a separate explicit non-heartbeat operator execution may produce a verified receipt.

Capital live readiness is all-product first: A50/CN0000 is a legacy direct-request advisory unless it is selected by the current all-product paper-intent pool. Readiness must include `sourceReports.currentPaperIntents.found=true` and `quoteFreshness.currentPaperIntents.generatedIntentCount`; stale A50 alone must not block the all-product strategy pool when fresh paper intents already exist for other symbols.

All operator-visible Capital/OKX/OpenClaw validation commands emitted from these reports must be repo-root qualified as `pnpm --dir D:\OpenClaw ...` (or the runtime-resolved repo root). This prevents `ERR_PNPM_NO_PKG_MANIFEST` when a copied command is pasted from `C:\Users\user` or another non-repo terminal.

Capital high-confidence paper rerun reports must isolate fresh paper intents above the confidence threshold under `.openclaw/trading/capital-high-confidence-paper-rerun/`, rerun strategy fill simulation against those temporary intents, expose whether the required confidence is reachable, and keep `noOrderWrite=true` without changing active intents or broker adapter state.

Capital micro alternative paper rerun reports must isolate lower-notional energy alternatives such as `MCL0000` and `QM0000`, write temporary paper-only intents under `.openclaw/trading/capital-micro-alternative-paper-rerun/`, and expose tail p05 pass/block evidence without changing active intents or broker adapter state.

## Autonomous Inventory Contract Probe

`contract-probe:json-required-path-message`, `contract-probe:json-non-empty-message`, `contract-probe:next-command-short-row-gate-verified-message`, `contract-probe:controlled-runner-next-safe-dmad-validation-command`, `contract-probe:controlled-runner-next-safe-dmad-publish-machine-line`, `contract-probe:controlled-runner-next-safe-dmad-publish-verified`, `contract-probe:dmad-heartbeat-readback-next-safe-non-empty`, `contract-probe:dmad-heartbeat-readback-message-next-safe`, `contract-probe:dmad-heartbeat-readback-xml-next-safe`, `contract-probe:dmad-heartbeat-readpoint-next-safe`, `contract-probe:dmad-heartbeat-readpoint-stdout-free`, `contract-probe:dmad-heartbeat-readpoint-dispatchable`, `contract-probe:dmad-heartbeat-readback-generated-at-freshness`, `contract-probe:controlled-telegram-next-command-machine-line-message`, `contract-probe:controlled-telegram-publish-message-next-command`, `contract-probe:controlled-telegram-publish-message-capital-operator-packet`, `contract-probe:controlled-telegram-publish-message-capital-operator-can-execute`, `contract-probe:controlled-telegram-publish-message-capital-operator-apply-receipt`, `contract-probe:controlled-telegram-publish-message-capital-operator-apply-receipt-verified`, `contract-probe:controlled-telegram-publish-message-okx-refresh`, `contract-probe:controlled-telegram-publish-message-no-order-write`, `contract-probe:controlled-telegram-publish-token-summary-dmad-gate`, and `contract-probe:controlled-telegram-publish-token-count-dmad-gate` are in-memory negative probes in `scripts/openclaw-autonomous-inventory.mjs`. They validate that deep JSON contract failures name the missing path directly, that non-empty string requirements fail closed, and that stale generated-at timestamps fail closed. The status-strip probe removes `summary.assistantClosure.statusStripFixtureCoverage.visibleInAssistantStatusStrip` and expects:

```text
missing JSON path "summary.assistantClosure.statusStripFixtureCoverage.visibleInAssistantStatusStrip" expected true
```

The next-command row probe removes `summary.assistantClosure.assistantLearningHint.nextCommandShortRow.gateVerified` and expects:

```text
missing JSON path "summary.assistantClosure.assistantLearningHint.nextCommandShortRow.gateVerified" expected true
```

The controlled-runner next-safe DMAD validation probe removes `dmad_validation_hint.command` and expects:

```text
missing JSON path "dmad_validation_hint.command" expected string containing "pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full"
```

The controlled-runner next-safe DMAD publish probes remove `dmad_publish_status.machineLine` and `dmad_publish_status.verified` and expect:

```text
missing JSON path "dmad_publish_status.machineLine" expected string containing "dmadPublish="
missing JSON path "dmad_publish_status.verified" expected true
```

The controlled-runner Telegram probe removes `telegram_trading_shortcuts.nextCommandMachineLine` and expects:

```text
missing JSON path "telegram_trading_shortcuts.nextCommandMachineLine" expected string containing "nextCommandShortRow="
```

The controlled-runner Telegram OKX heartbeat probes remove `telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine` and expect:

```text
missing JSON path "telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine" expected string containing "okxHeartbeatRefresh="
missing JSON path "telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine" expected string containing "executeRequired="
missing JSON path "telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine" expected string containing "schedulerNextRunAt="
missing JSON path "telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine" expected string containing "noOrderWrite=true"
```

The controlled-runner Telegram publish probe removes `message` and expects:

```text
missing JSON path "message" expected string containing "下一步指令=nextCommandShortRow="
missing JSON path "message" expected string containing "OKX刷新=okxCurrentReadinessRefresh="
missing JSON path "message" expected string containing "OKX心跳=okxHeartbeatRefresh="
missing JSON path "message" expected string containing "executeRequired="
missing JSON path "message" expected string containing "schedulerNextRunAt="
missing JSON path "message" expected string containing "noOrderWrite=true"
missing JSON path "messageTokenCountsSummaryZhTw" expected string containing "OKX刷新=1"
missing JSON path "messageTokenCountsSummaryZhTw" expected string containing "OKX心跳=1"
missing JSON path "messageTokenCountsSummaryZhTw" expected string containing "noOrderWrite=true=4"
missing JSON path "messageTokenCountsSummaryZhTw" expected string containing "DMAD=1"
missing JSON path "messageTokenCounts.noOrderWrite" expected 4
missing JSON path "messageTokenCounts.dmadGate" expected 1
```

Verification:

```bash
node --check scripts/openclaw-autonomous-inventory.mjs
pnpm autonomous:inventory:check
```

The Telegram trading shortcuts report contract also requires `summary.assistantClosure.assistantLearningHint.nextCommandShortRow.command`, `gateVerified`, and `machineLine` so `sc:trade`, `sc:tr:assist`, and `sc:tr:learn` share a machine-readable next-command row.

The controlled-runner Telegram summary contract requires `telegram_trading_shortcuts.machineLine`, `telegram_trading_shortcuts.nextCommandMachineLine`, `telegram_trading_shortcuts.okxHeartbeatRefreshMachineLine`, `okx_current_readiness_refresh_workflow.machineLine`, `dmad_validation_hint.machineLine`, `dmad_publish_status.machineLine`, `telegram_summary_oneline`, and `telegram_summary_oneline_zh_tw` to carry `shortcutChecks=`, `nextCommandShortRow=`, `okxCurrentReadinessRefresh=`, `okxHeartbeatRefresh=`, `schedulerNextRunAt=`, `executeRequired=`, `noOrderWrite=true`, `dmadGate=timeout-smoke:gate:ultra:verify:ultra:full`, and `dmadPublish=verified`. Both one-line fields must include the raw `dmad_publish_status.machineLine` token so external monitoring can grep `dmadPublish=verified` without opening JSON or markdown. It also carries `riskResizedReject=riskResizedRejectionSummary=...` / `縮風險淘汰=...` from the paper-only risk-resized rejection summary, including rejected symbols, p05 point/notional reasons, and `noOrderWrite:ok` so Telegram can show why candidates stayed blocked without increasing the operational `noOrderWrite=true` token count. It also mirrors the latest Telegram publish token-count summary into `okx_heartbeat_publish_token_counts` and `telegram_summary_oneline_zh_tw` as `OKX心跳計數=messageTokenCounts ... noOrderWrite=true=4 ...`, while the publish bridge counts only operational `executeRequired=true|false` and `noOrderWrite=true` tokens so the summary cannot self-increment. The markdown render must include `- dmad_publish_status: dmadPublish=verified...`, and the inventory gate reads `openclaw-controlled-task-runner-telegram-latest.md` with a text contract for that line plus `dmadGate=1;summaryDmad=true`, so human-readable reports show the DMAD publish state without opening JSON. This keeps the publish bridge, `/status`, DMAD gate, and automation heartbeat summary aligned on the same machine-readable trading shortcut, OKX refresh, OKX heartbeat scheduler, and DMAD publish closure rows.

The controlled-runner latest state now mirrors the Telegram publish bridge under `dmad_publish_status`, requiring `machineLine=dmadPublish=verified`, `upstreamDmadGateCount=1`, `upstreamDmadGateVerified=true`, and `upstreamSummaryHasDmad=true`. The controlled-runner next-safe JSON also carries `dmad_validation_hint.command=pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full`, the latest `dmad_publish_status`, and a top-level `machineLine=nextSafe=...;dmadGate=...;dmadPublish=...;readOnly=true`. Plain `autonomous:controlled:next-safe` output mirrors that as `machine_line=...`, so DMAD automation heartbeats can read both the current local validation gate and publish visibility from one grep-friendly line instead of scraping the speedup ledger or publish report.

The DMAD heartbeat next-safe readback helper (`pnpm dmad:heartbeat-next-safe-readback`) enforces the consumer rule for that automation surface: run plain `autonomous:controlled:next-safe` first and accept `machine_line=` only when it includes `nextSafe=`, `dmadGate=`, `dmadPublish=`, and `readOnly=true`; if the plain line is missing or incomplete, rerun the controlled runner with `--json` and derive the same machine line from the top-level `machineLine` or from `dmad_validation_hint.machineLine` plus `dmad_publish_status.machineLine`. The helper writes `reports/hermes-agent/state/openclaw-dmad-heartbeat-next-safe-readback-latest.json` by default with `schema=openclaw.dmad.heartbeat-next-safe-readback.v1`, `mode=state_write`, `status=ready`, the accepted `nextSafe`, a `heartbeat.message` token containing `next_safe=...` and `dispatchable=true`, a ready-to-forward `heartbeat.xml` block containing the same message, `automationReadPoint.stdoutRequired=false`, `automationReadPoint.selector=heartbeat.xml`, `automationReadPoint.dispatchable=true`, the accepted `machineLine`, `fallbackReason=null` for the plain-first path, `freshness.status=ok`, and read-only/no-external-write safety flags, so heartbeat automation has one stable artifact read point with JSON fallback and a durable latest artifact while keeping the default path grep-friendly. Stale or blocked reports keep the diagnostic `nextSafe` value but set `heartbeat.decision=DONT_NOTIFY`, `dispatchable=false`, and `automationReadPoint.blockedReason`, so external automation can inspect the stale artifact without continuing dispatch. Plain output includes `next_safe=`, `dispatchable=`, `generated_at=`, `freshness=`, `freshness_age_ms=`, `freshness_max_age_ms=`, and when blocked, `freshness_reason=`, `blocked_reason=`, plus `dispatch_blocked_reason=` so operators can route the next task and see stale-state failures without opening JSON or parsing the full machine line. `pnpm dmad:heartbeat-next-safe-readback:check` verifies those plain ready/stale dispatch lines with an injected runner and no latest-artifact write. `pnpm dmad:heartbeat-next-safe-readback -- --json --no-write-state` emits the same report with `mode=no_write` and without refreshing the latest artifact for read-only heartbeat checks. Inventory requires the helper and check scripts, non-empty `nextSafe`, non-empty `heartbeat.nextSafe`, `heartbeat.message` with `next_safe=`, `heartbeat.xml` with `<message>next_safe=`, non-empty `automationReadPoint.nextSafe`, `automationReadPoint.stdoutRequired=false`, `automationReadPoint.dispatchable=true`, `automationReadPoint.selector=heartbeat.xml`, `mode=state_write`, `fallbackReason=null`, `freshness.status=ok`, and `generatedAt` not older than 24 hours, which keeps stale/no-write/fallback-derived latest artifacts visible but blocks them from being treated as the normal ready path.

The controlled-runner Telegram publish dry-run contract requires `status=dry_run_ok`, `errorCode=OK`, `dryRun=true`, `dryRunNoSend=true`, `commandErrorCode=DRY_RUN_NO_SEND`, and a message that carries `快捷檢查=shortcutChecks=`, `OKX刷新=okxCurrentReadinessRefresh=`, `OKX心跳=okxHeartbeatRefresh=`, `schedulerNextRunAt=`, `executeRequired=`, `noOrderWrite=true`, `下一步指令=nextCommandShortRow=`, and `DMAD=timeout-smoke:gate:ultra:verify:ultra:full`. It also records `messageTokenCounts.okxRefresh=1`, `messageTokenCounts.okxHeartbeat=1`, `messageTokenCounts.executeRequired=1`, `messageTokenCounts.noOrderWrite=4`, `messageTokenCounts.dmadGate=1`, and a human-readable `messageTokenCountsSummaryZhTw` containing `OKX刷新=1`, `OKX心跳=1`, `noOrderWrite=true=4`, and `DMAD=1` so generated reports catch accidental duplicate suffixes or missing DMAD gate forwarding. The controlled-runner publish bridge status report mirrors those upstream counts as `upstreamMessageTokenCounts`, `upstreamMessageTokenCountsSummaryZhTw`, `upstreamNoOrderWriteCount=4`, `upstreamNoOrderWriteVerified=true`, `upstreamDmadGateCount=1`, and `upstreamDmadGateVerified=true` so `validation_result.telegram_publish` can prove the dry-run payload stayed read-only and kept the DMAD gate visible without reopening the publish report. This proves the publish bridge can read the current summary and produce the operator-facing Telegram payload without sending a real message.

The Telegram trading shortcuts checker mirrors these inventory requirements under `summary.okxCurrentReadinessInventoryProbeClosure`. Its machine line reports `okxInventoryProbe=`, the publish probe count, and `noOrderWrite=true` so the Telegram shortcut report can show whether the autonomous inventory gate protects the OKX refresh message contract.

The same checker now mirrors the controlled-runner Telegram publish token-count report under `summary.okxHeartbeatPublishTokenCountClosure`. The assistant status strip and `sc:tr:okxrefresh` callback next-action reply must show `okxHeartbeatTokenCounts=<code>messageTokenCounts ... noOrderWrite=true=4 ... DMAD=1</code>` so operators can see the OKX refresh / heartbeat / executeRequired / noOrderWrite / DMAD token counts without opening JSON. The inventory probe must report all configured summary and publish probes passing, covering scheduler readback, message-token presence, token-count readback, Capital adapter apply receipt visibility, and DMAD gate forwarding.

The OKX current-readiness heartbeat operation mirrors that closure under `reports.inventoryProbe` and adds `inventoryProbe=ready|blocked` to `machineLine`. It also reads `openclaw-controlled-task-runner-telegram-publish-bridge-latest.json` into `reports.inventoryProbe.publishBridgeStatus`, carrying `publishBridge=pass`, `upstreamNoOrderWriteVerified=true`, `upstreamNoOrderWriteCount=4`, `upstreamDmadGateVerified=true`, `upstreamDmadGateCount=1`, `noOrderWrite=true=4`, and `DMAD=1` so heartbeat inventory status can prove the upstream dry-run publish payload stayed read-only and kept the DMAD gate visible. The `sc:tr:okxrefresh` callback next-action reply and the `sc:tr:assist` assistant status strip must render the same bridge line as `okxHeartbeatPublishBridge=<code>publishBridge=pass ... upstreamNoOrderWriteVerified=true ... upstreamDmadGateVerified=true ... noOrderWrite=true=4 ... DMAD=1</code>`, and must expose the scheduler readback as `okxHeartbeatSchedulerNextRunAt=<code>...</code>`, keeping heartbeat notifications aligned with the same OKX refresh / scheduler / `noOrderWrite=true` / DMAD Telegram inventory probe before any operator uses `sc:tr:okxrefresh`.

## Evolution learning architecture gate

`check:openclaw-evolution-learning-architecture` verifies that `extensions/evolution-learning` is OpenClaw-native before any split or promotion work. The gate checks manifest metadata, the package-owned entrypoint, Plugin SDK usage, the four-layer hooks and operator surfaces, Hermes learning bridge anchors, and the English / Traditional Chinese architecture ADRs.

The current four-layer contract is:

- Layer 1: operational learning through `before_prompt_build` capture and usage consolidation.
- Layer 2: neural routing through `before_model_resolve` and soft-link weights.
- Layer 3: growth pulse through the REM service and growth metrics.
- Layer 4: organic cells through the cell registry, promotion, and auto-hatching surfaces.

Verification:

```bash
node --check scripts/check-openclaw-evolution-learning-architecture.mjs
pnpm check:openclaw-evolution-learning-architecture
pnpm autonomous:inventory:check
```

## Card framework gate

`check:openclaw-card-framework` verifies that future module planning is cardized, linked, and readable before implementation. The gate reads `reports/openclaw-card-framework-cards.json`, checks Source / Component / Capability / Module / Contract / Validation / Report card coverage, validates OpenClaw targets (`docs`, `skill`, `plugin`, `runtime`, `taskflow`), checks multi-card links, verifies source URLs or repo paths, checks original architecture `componentRole` / `componentPaths` coverage, checks the builder skill at `skills/openclaw-card-framework-builder/SKILL.md`, runs 1000 production-validator scenarios, and emits a Chinese PASS/FAIL report that an operator can read without opening JSON.

`openclaw:card:graph` exports the same validated registry to `reports/openclaw-card-framework-graph.json` as stable `nodes` / `links` / `viewpoints` data for 2D/3D visual checks and future dry-run module generation. `openclaw:card:graph:check` fails when the graph export is missing or stale, so a 3D view cannot drift away from the card registry.

`openclaw:card:viewer` renders the graph export to `reports/openclaw-card-framework-3d-viewer.html` as a read-only 3D viewpoint. The viewer embeds only the validated graph JSON, supports node selection and viewpoint switching, and never exposes task execution actions from graph nodes. `openclaw:card:viewer:check` fails when the viewer export is missing or stale.

`openclaw:card:generate` reads the graph export and writes `reports/openclaw-card-module-generator-dry-run-latest.json` with dry-run plans for future skill/plugin/runtime/taskflow/agent files. It lists planned files, validation commands, rollback, safety flags, and per-card staged apply proposals only; it does not create runtime files, enable external APIs, or enable live trading. `openclaw:card:generate:check` fails when the dry-run report is missing or stale.

`openclaw:card:proposal -- --card <card-id>` exports only one card proposal to `reports/openclaw-card-module-proposal-latest.json` (or `--out <path>`). Proposal-only mode is dry-run only and fails when `--card` is missing.

The gate blocks cards that are standalone helpers, missing source evidence, outside-root source paths, missing contracts, missing validation commands, missing links, missing original architecture component coverage, missing component paths, using unsupported OpenClaw targets, declaring real API/write risk, or disconnecting trading runtime from the trading risk gate. The scenario simulation must keep `falseAccepted=0` and `falseBlocked=0`.

The required original architecture Component Card roles are `gateway`, `channel`, `plugin-loader`, `plugin-sdk`, `extension`, `skill`, `controlled-runner`, `taskflow`, `scheduler-hooks`, `memory`, `ui-surface`, `config`, `validation-gate`, `report-state`, `trading-runtime`, and `trading-risk-gate`. Trading components must remain linked as `trading-runtime -> trading-risk-gate -> validation-gate/report-state`, so cardization cannot bypass paper-only checks or live/write blocks.

The controlled task runner calls the same card framework validator before executing a task. If the Component Card graph, 1000-run simulation, or trading risk-gate link fails, the runner records `BLOCKED_CARD_FRAMEWORK` and skips the task command. The runner now derives `next_safe_task` card id from `reports/openclaw-card-framework-graph.json` and auto-writes `reports/hermes-agent/state/openclaw-controlled-task-runner-next-safe-card-proposal-latest.json` with a dry-run-only single-card staged proposal.

The human report includes an original-architecture impact simulation line. It must show every required Component Card protected, controlled-runner preflight enforced, the trading risk gate enforced, and the destructive break cases blocked: missing component role, missing component path, trading runtime without risk gate, and trading runtime with live/write risk.

Verification:

```bash
node --check scripts/check-openclaw-card-framework.mjs
node --check scripts/export-openclaw-card-framework-graph.mjs
node --check scripts/generate-openclaw-card-module-dry-run.mjs
node --check scripts/render-openclaw-card-framework-viewer.mjs
pnpm check:openclaw-card-framework
pnpm openclaw:card:graph:check
pnpm openclaw:card:generate:check
pnpm openclaw:card:proposal -- --card module-3d-viewpoint-node-model
pnpm openclaw:card:viewer:check
pnpm autonomous:inventory:check
```

## BrokerDesk quote surface

`brokerdesk:quote:*` belongs to the BrokerDesk quote reader surface, not the Hermes orchestration layer.

- `scripts/openclaw-capital-quote-reader.mjs`
- `scripts/check-capital-quote-reader.mjs`
- `scripts/openclaw-capital-quote-status.mjs`
- `scripts/check-capital-quote-status.mjs`
- `scripts/openclaw-capital-quote-pump.mjs`
- `scripts/check-capital-quote-pump.mjs`
- `scripts/openclaw-capital-quote-runtime-event.mjs`
- `scripts/check-capital-quote-runtime-event.mjs`
- `scripts/openclaw-capital-reportable-quote-state.mjs`
- `scripts/check-capital-reportable-quote-state.mjs`
- `scripts/openclaw-capital-reportable-quote-refresh.mjs`
- `scripts/check-capital-reportable-quote-refresh.mjs`
- `scripts/openclaw-capital-active-page-refresh-plan.mjs`
- `scripts/check-capital-active-page-refresh-plan.mjs`
- `scripts/openclaw-capital-quote-architecture.mjs`
- `scripts/check-capital-quote-architecture.mjs`
- `scripts/openclaw-capital-quote-ui-state.mjs`
- `scripts/check-capital-quote-ui-state.mjs`
- `scripts/validate-capital-quote-state.mjs`

These commands verify and report quote state only. They do not own Hermes task packaging, approval, UI rendering, or learning/promotion flow.

The architecture gate must pass before a runtime or strategy layer treats BrokerDesk quote state as usable context. It checks package scripts, required quote files, skill guardrails, generated status/event schemas, read-only safety flags, event type mapping, strategy gate consistency, and latest-symbol consistency.

The quote pump is the safe bridge from BrokerDesk callback output to OpenClaw runtime state. It reads BrokerDesk files, rewrites OpenClaw quote status/runtime event with a strict max quote age, and never logs in or writes broker orders. Stale pump output must block paper trading instead of retrying the broker.

The active-page refresh plan is the read-only bridge from overseas product rotation into the operator-controlled BrokerDesk/SKCOM refresh loop. It records the exact `--os-stocks` activePage arguments, requires the human-controlled quote session to perform any refresh, then gates paper evaluator access on `capital:quote:reportable` and `capital:energy-callback-verification:check`. It never logs in, subscribes, or sends broker orders from OpenClaw.

## OKX CEX status surface

`okx:api-status` is the OpenClaw-native read-only OKX CEX status gate. It owns market-data availability, local credential health, and security-policy blockers for chat-posted or over-permissioned keys.

- `skills/openclaw-okx-cex-status/SKILL.md`
- `scripts/openclaw-okx-api-status-gate.mjs`
- `scripts/check-openclaw-okx-api-status-gate.mjs`
- `scripts/openclaw-okx-market-snapshot-loop.mjs`
- `scripts/check-openclaw-okx-market-snapshot-loop.mjs`
- `scripts/openclaw-okx-market-snapshot-gate.mjs`
- `scripts/check-openclaw-okx-market-snapshot-gate.mjs`
- `scripts/openclaw-okx-market-snapshot-scheduler.mjs`
- `scripts/check-openclaw-okx-market-snapshot-scheduler.mjs`
- `scripts/openclaw-okx-paper-signal-gate.mjs`
- `scripts/check-openclaw-okx-paper-signal-gate.mjs`
- `scripts/openclaw-okx-order-proposal-gate.mjs`
- `scripts/check-openclaw-okx-order-proposal-gate.mjs`
- `scripts/openclaw-okx-order-status-gate.mjs`
- `scripts/check-openclaw-okx-order-status-gate.mjs`
- `scripts/openclaw-okx-demo-order-simulation-result-gate.mjs`
- `scripts/check-openclaw-okx-demo-order-simulation-result-gate.mjs`
- `scripts/openclaw-okx-paper-audit-log-gate.mjs`
- `scripts/check-openclaw-okx-paper-audit-log-gate.mjs`
- `scripts/openclaw-okx-paper-audit-summary-gate.mjs`
- `scripts/check-openclaw-okx-paper-audit-summary-gate.mjs`
- `scripts/openclaw-okx-current-readiness-summary.mjs`
- `scripts/check-openclaw-okx-current-readiness-summary.mjs`
- `scripts/openclaw-okx-current-readiness-refresh-workflow.mjs`
- `scripts/check-openclaw-okx-current-readiness-refresh-workflow.mjs`
- `scripts/openclaw-okx-current-readiness-heartbeat-operation.mjs`
- `scripts/check-openclaw-okx-current-readiness-heartbeat-operation.mjs`
- `reports/hermes-agent/state/openclaw-okx-api-status-gate-latest.json`
- `reports/hermes-agent/state/openclaw-okx-api-status-gate-latest.json.sha256`
- `reports/hermes-agent/state/openclaw-okx-market-snapshot-loop-latest.json`
- `reports/hermes-agent/state/openclaw-okx-market-snapshot-loop-latest.json.sha256`
- `reports/hermes-agent/state/openclaw-okx-market-snapshot-gate-latest.json`
- `reports/hermes-agent/state/openclaw-okx-market-snapshot-gate-latest.json.sha256`
- `reports/hermes-agent/state/openclaw-okx-market-snapshot-scheduler-latest.json`
- `reports/hermes-agent/state/openclaw-okx-market-snapshot-scheduler-latest.json.sha256`
- `reports/hermes-agent/state/openclaw-okx-paper-signal-gate-latest.json`
- `reports/hermes-agent/state/openclaw-okx-paper-signal-gate-latest.json.sha256`
- `reports/hermes-agent/state/openclaw-okx-order-proposal-gate-latest.json`
- `reports/hermes-agent/state/openclaw-okx-order-proposal-gate-latest.json.sha256`
- `reports/hermes-agent/state/openclaw-okx-order-status-gate-latest.json`
- `reports/hermes-agent/state/openclaw-okx-order-status-gate-latest.json.sha256`
- `reports/hermes-agent/state/openclaw-okx-demo-order-simulation-result-gate-latest.json`
- `reports/hermes-agent/state/openclaw-okx-demo-order-simulation-result-gate-latest.json.sha256`
- `reports/hermes-agent/state/openclaw-okx-paper-audit-log.jsonl`
- `reports/hermes-agent/state/openclaw-okx-paper-audit-log-latest.json`
- `reports/hermes-agent/state/openclaw-okx-paper-audit-log-latest.json.sha256`
- `reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json`
- `reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json.sha256`
- `reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json`
- `reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json.sha256`
- `reports/hermes-agent/state/openclaw-okx-current-readiness-refresh-workflow-latest.json`
- `reports/hermes-agent/state/openclaw-okx-current-readiness-refresh-workflow-latest.json.sha256`
- `reports/hermes-agent/state/openclaw-okx-current-readiness-heartbeat-operation-latest.json`
- `reports/hermes-agent/state/openclaw-okx-current-readiness-heartbeat-operation-latest.json.sha256`
- `okx:demo-simulation`
- `okx:demo-simulation:check`
- `okx:paper-audit-log`
- `okx:paper-audit-log:check`
- `okx:paper-audit-summary`
- `okx:paper-audit-summary:check`
- `okx:current-readiness`
- `okx:current-readiness:check`
- `okx:current-readiness:heartbeat`
- `okx:current-readiness:heartbeat:check`
- `okx:current-readiness:heartbeat:execute`
- `okx:current-readiness:refresh`
- `okx:current-readiness:refresh:check`
- `okx:api-status`
- `okx:api-status:check`
- `okx:market-loop`
- `okx:market-loop:check`
- `okx:market-snapshot`
- `okx:market-snapshot:check`
- `okx:market-snapshot:scheduler`
- `okx:market-snapshot:scheduler:check`
- `okx:paper-signal`
- `okx:paper-signal:check`
- `okx:order-proposal`
- `okx:order-proposal:check`
- `okx:order-status`
- `okx:order-status:check`

This surface does not depend on Codex global OKX skills as a formal runtime source. It reads local OKX CLI/config state only, never stores secrets in the repo, and keeps order placement, cancellation, amendment, withdrawal, transfer, and live trading disabled. The market snapshot gate reads public `SPOT`, `SWAP`, `FUTURES`, and `OPTION` tickers as an on-demand snapshot. The market snapshot scheduler installs exactly one OpenClaw cron job, `OKX market snapshot read-only refresh`, every 5 minutes with an isolated `agentTurn` payload that may run only `pnpm okx:market-snapshot` and `pnpm okx:market-snapshot:check`, with `exec/read` tools only and `noOrderWrite=true`. The market loop reads the same public ticker groups every second, stays below the official `GET /api/v5/market/tickers` limit of 20 requests per 2 seconds, and remains read-only for paper/dry-run strategy context. The paper signal gate consumes loop output to score paper-only candidates (`paper_hold` / `paper_watch_long` / `paper_watch_short`) while keeping order execution disabled. The order proposal gate is dry-run only: it pre-fills `instId` / `side` / `market` from the latest paper-signal top candidate (unless CLI overrides), emits a zero-size non-actionable placeholder, keeps `submissionCommand` empty, and records `submittedOrder=false`. Keys posted in chat, keys with withdraw permission, and write-capable keys without an IP allowlist now stay as policy warnings for paper/dry-run proposal flow, and remain non-bypassable requirements before any future live promotion work.
The order status gate records OKX's official order-details and cancel-order endpoint map plus a local demo-only order lifecycle simulation proof. The demo simulation result gate extracts that local proof into a standalone report with `submittedOrder=false`, `exchangeWriteAttempted=false`, `orderStatusQueryExecuted=false`, and `cancelSubmitted=false`. The paper audit log gate appends that non-secret result to JSONL with a digest and the same safety flags. The paper audit summary gate reads that JSONL only, reports counts and latest entry metadata, and blocks if any entry records order submission, exchange writes, private order queries, cancellation, live trading, or credential exposure. Private order queries, exchange order writes, and cancellation stay disabled until OpenClaw has a submitted order id plus separate approval and promotion evidence.

The Telegram visibility closure exposes the paper audit summary without reading JSONL contents. `sc:tr:platform` shows the OKX Paper Audit block from `trading.snapshot`, `sc:tr:okxstat` shows the same summary on the standalone OKX order-status panel, and `sc:tr:assist` shows `okxPaperAuditClosure.machineLine` in the simulation assistant fast status strip. The `capital-hft:telegram-trading-shortcuts:check` gate must keep this machine-readable line green: `okxPaperAudit=pass platform=read+visible okxstat=read+visible report=reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json noOrderWrite=true`.

The current readiness summary reads the local market snapshot, market snapshot scheduler, demo simulation result, paper audit summary, and Telegram shortcut report into one status artifact. It is summary-only, checks each source report's `generatedAt` freshness, and blocks stale market/scheduler/demo/audit/Telegram reports before they can be promoted as ready. It also blocks when the scheduler `nextRunAt` drifts outside the freshness grace window, and the scheduler/current-readiness/heartbeat `machineLine` strings must echo `nextRunAt=` / `schedulerNextRunAt=` with `noOrderWrite=true` so operators can verify the next refresh readback without opening JSON. The refresh workflow is the one-command recovery path for that stale blocker: it reruns market snapshot, market snapshot scheduler, demo simulation, paper audit log, paper audit summary, Telegram shortcut closure, and current-readiness check in order, then writes `openclaw-okx-current-readiness-refresh-workflow-latest.json`. It keeps OKX private order queries, order writes, cancellation, live trading, withdrawal, and transfer disabled. `sc:tr:okx` shows the OKX Current Readiness block from `openclaw-okx-current-readiness-summary-latest.json`, the latest refresh workflow `steps` / `failedSteps` / `latestRefreshRun` summary from `openclaw-okx-current-readiness-refresh-workflow-latest.json` and `openclaw-okx-current-readiness-heartbeat-operation-latest.json`, plus the OKX market snapshot scheduler block from `openclaw-okx-market-snapshot-scheduler-latest.json`, including next refresh time and `noOrderWrite=true`; `sc:tr:okxrefresh` starts the safe `pnpm okx:current-readiness:refresh` operation entry and echoes the heartbeat `nextSafeTask`, refresh callback/command, `oneClickRefresh`, `executeRequired`, inventory probe status/machine line, and `noOrderWrite` flags in the operation reply; `pnpm okx:current-readiness:heartbeat` exposes the same refresh path as a heartbeat operation entry with `pnpm okx:current-readiness:heartbeat:execute` as the explicit one-click executor. `sc:tr:assist` shows `okxCurrentReadinessClosure.machineLine`; the line must include `okxCurrentReadiness=ready`, `scheduler=pass`, `schedulerNextRunAt=...`, `refresh=available`, `freshness=ok`, and `noOrderWrite=true`. The assistant fast status strip also shows the refresh workflow `machineLine`, `steps`, `failedSteps`, `latestRefreshRun`, and `noOrderWrite=true` from the workflow and heartbeat reports. `openclaw-telegram-trading-shortcuts-latest.json` now mirrors the same refresh workflow machine summary under `summary.okxCurrentReadinessRefreshWorkflowClosure`, including `machineLine`, `passedSteps/totalSteps`, `failedSteps`, `latestRefreshRun`, `reportRead`, `assistantStatusStripVisible`, and `noOrderWrite=true`. The heartbeat operation line must include `okxCurrentReadinessHeartbeat=refresh_available`, `telegram=sc:tr:okxrefresh`, `command=okx:current-readiness:refresh`, `schedulerNextRunAt=...`, `inventoryProbe=ready|blocked`, and `noOrderWrite=true` when stale blockers require a refresh. The assistant fast status strip also shows the heartbeat `nextSafeTask`, `oneClickRefresh`, `executeRequired`, and `noOrderWrite` flags so the operator can see whether `sc:tr:okxrefresh` is needed without opening the raw report.

## Capital paper HFT automation surface

`brokerdesk:paper-hft:*` and `brokerdesk:paper-trade:*` belong to the paper-only automation surface. They do not enable live broker writes.

- `config/capital-paper-hft-risk-controls.json`
- `config/capital-paper-microstructure-strategy.json`
- `scripts/openclaw-capital-paper-automation-loop.mjs`
- `scripts/check-capital-paper-automation-loop.mjs`
- `scripts/check-capital-paper-cron-job.mjs`
- `scripts/openclaw-capital-paper-hft-burst.mjs`
- `scripts/check-capital-paper-hft-burst.mjs`
- `scripts/openclaw-capital-paper-hft-trigger.mjs`
- `scripts/check-capital-paper-hft-trigger.mjs`
- `scripts/openclaw-capital-paper-learning-summary.mjs`
- `scripts/check-capital-paper-learning-summary.mjs`
- `scripts/openclaw-capital-paper-assistant-state.mjs`
- `scripts/check-capital-paper-assistant-state.mjs`
- `scripts/openclaw-capital-paper-promotion-gate.mjs`
- `scripts/check-capital-paper-promotion-gate.mjs`
- `capital-hft:auto-trading`
- `capital-hft:auto-trading:check`
- `capital-hft:auto-trading-loop`
- `capital-hft:auto-trading-loop:check`
- `capital-hft:auto-trading-watch`
- `capital-hft:auto-trading-watch:daemon`
- `capital-hft:auto-trading-watch:check`
- `scripts/openclaw-auto-trading-assistant.mjs`
- `scripts/check-auto-trading-assistant-state.mjs`
- `scripts/openclaw-auto-trading-watch.mjs`
- `scripts/check-auto-trading-watch-state.mjs`
- `scripts/openclaw-auto-trading-learning-snapshot.mjs`
- `scripts/check-auto-trading-learning-snapshot.mjs`
- `scripts/openclaw-auto-trading-tick-diagnostic.mjs`
- `scripts/check-auto-trading-tick-diagnostic.mjs`
- `scripts/check-openclaw-telegram-trading-shortcuts.mjs`
- `reports/hermes-agent/state/openclaw-telegram-trading-shortcuts-latest.json`
- `scripts/check-openclaw-tradingagents-integration.mjs`
- `scripts/check-openclaw-tradingagents-runtime.mjs`
- `scripts/check-openclaw-tradingagents-upstream.mjs`
- `scripts/check-openclaw-tradingagents-summary.mjs`
- `reports/hermes-agent/state/openclaw-tradingagents-summary-latest.json`
- `tradingagents:start`
- `tradingagents:stop`
- `tradingagents:status`
- `tradingagents:runtime:check`
- `tradingagents:integration:check`
- `tradingagents:upstream:status`
- `capital-hft:telegram-trading-shortcuts:check`
- `.openclaw/ui/auto-trading-learning-summary.md`
- `.openclaw/ui/auto-trading-assistant-state.json`
- `.openclaw/ui/auto-trading-watch-state.json`
- `.openclaw/ui/auto-trading-learning-snapshot.json`
- `.openclaw/quote/capital-tick-diagnostic.json`
- `.openclaw/quote/capital-tick-diagnostic.md`
- `scripts/openclaw-capital-paper-hft-readiness.mjs`
- `scripts/check-capital-paper-hft-readiness.mjs`
- `scripts/openclaw-capital-paper-trading-simulator.mjs`
- `scripts/check-capital-paper-trading-simulator.mjs`

The paper HFT readiness gate requires the BrokerDesk quote architecture gate to pass, runtime event strategy gate to be ready, quote freshness to satisfy the stricter HFT-like age limit, and risk controls to keep live trading and broker writes disabled. A failed readiness gate is a controlled block, not a signal to retry broker login.

The paper trading simulator consumes the readiness report and the latest quote state. It writes paper intent and learning ledger records only when readiness passes and bid/ask are usable. If readiness is blocked or bid/ask are invalid, it records a learning observation without creating an order intent.

The paper automation loop is the single safe heartbeat target for HFT-like simulation. It runs quote pump, quote architecture, paper HFT readiness, and one paper simulator cycle in order, then writes one loop report. It does not log in, retry broker API calls, advance quote queue StartIndex, or enable broker order writes.

The auto-trading watch command is the continuous quote-driven prototype entrypoint. It watches BrokerDesk quote callback files and reruns the paper automation loop whenever a new callback or guard/queue update arrives. It stays read-only, no-login, and paper-only.

The auto-trading watch daemon launcher prepares a Windows hidden background launch path for the watch loop and records its plan in OpenClaw state. The startup install/check entrypoints keep that plan verifiable without enabling broker writes.

The paper HFT burst runner is the short-cycle simulation entrypoint. It repeatedly executes the paper automation loop at the configured `decisionLoopIntervalMs` cadence, but stops immediately on stale quotes, 1115 cooldown, failed readiness, invalid bid/ask, max cycles, or max duration. It is paper-only and cannot enable broker writes.

The paper HFT trigger is the event-deduplication gate in front of burst execution. It reads the latest SKQuoteLib callback identity/hash, skips duplicate quotes, blocks stale or invalid bid/ask quotes without running burst, and only executes the paper HFT burst for a new actionable callback.

The paper learning summary is the read-only bridge from the learning registry to strategy promotion. It summarizes candidate / approved / blocked state, keeps paper and live eligibility separate, and surfaces the next safe task without enabling broker writes.

The 類高頻自動交易助手 state is the single OpenClaw control center for quote status, paper automation loop, learning summary, promotion gate, and cron check. It stays read-only, shows the strongest current status, and gives the operator one next safe task without enabling broker writes.

The Telegram trading shortcuts check is the UI-to-command evidence gate for the trading control surface. It verifies that the HFT gates, HFT-to-BrokerAdapter dispatcher, live-trading blocker, and Paper assistant buttons all have matching callback routes, package scripts, command targets, and assistant-state entrypoints. It records `no_live_order_sent` and keeps the live button blocker-only.

Telegram trading shortcuts must also expose the Capital operator packet's adapter apply receipt status as first-class report and Markdown summary fields. The shortcut summary must show `adapterApplyReceipt=pending_operator_apply|applied_receipt_verified`, `adapterApplyReceiptVerified=...`, `operatorMayApply`, and the apply-receipt validation next task so the operator can see when the next action is an adapter-owned ack apply rather than another quote or strategy repair. The controlled-runner Telegram publish line must preserve the same `adapterApplyReceipt=...`, `adapterApplyReceiptVerified=...`, and `operatorMayApply=...` tokens inside `真單Packet=...` so automation heartbeats and Telegram dry-run reports expose the exact broker-ack apply blocker without reopening JSON reports.

The TradingAgents bridge is an OpenClaw-owned paper signal surface for the official TauricResearch/TradingAgents candidate. The summary report must keep `canAnalyzeNow=true`, `runtime.mode=paper_signal_only`, `runtime.noOrderWrite=true`, `runtime.brokerWriteAttempted=false`, and `no_live_order_sent=true`. Official upstream installation stays an explicit operator step through `tradingagents:install`; the inventory gate only accepts the local bridge and report contract, not live broker writes.

The paper promotion gate is the read-only threshold check that consumes the learning summary and decides whether the strategy is ready for paper promotion review. It does not promote live, does not enable writes, and keeps the next safe task explicit when the gate is still blocked.

The paper cron job check validates the OpenClaw-owned scheduler entry for the paper HFT trigger. It checks that exactly one `Capital paper HFT trigger` job exists, is enabled, runs every 30 minutes in an isolated session, uses `brokerdesk:paper-hft:trigger` as the only entrypoint, and keeps delivery/tool/live-trading guardrails locked.

## Hermes migration contract

`extensions/migrate-hermes/openclaw.plugin.json` must keep:

- `id: "migrate-hermes"`
- `contracts.migrationProviders` contains `"hermes"`

## WebApp encoded-path guard matrix

`extensions/automation/src/register.ts` and `extensions/automation/src/register.test.ts` define the WebApp route guard contract for encoded paths.

Quick index:

- Keep single-hop traceability: [Autonomous Runtime related spec anchor](./autonomous-runtime.md#related-spec-anchor) -> `hasPathTraversalAttempt` (`extensions/automation/src/register.ts`) -> `automation register webapp bundle fallback` (`extensions/automation/src/register.test.ts`).

- Must block traversal payloads (forward slash and backslash variants), including multi-encoded forms.
- Must block malformed percent-encoding (`%E0%A4%A`, `%2G`, standalone `%`).
- Must fail closed when decode budget is exceeded and encoded octets still remain.
- Must allow in-root non-traversal paths that stay within decode budget (for example encoded `%25` asset names).

Route-level exception matrix: `allows high-encoded non-traversal asset path within decode budget` -> allow `/superclaw/assets/ratio%25252525.png`; `returns forbidden payload when high-encoded non-traversal asset path exceeds decode budget` -> deny `/superclaw/assets/ratio%2525252525.png`; `returns forbidden payload when invalid hex encoding is detected` -> deny `/superclaw/assets/%2G.png`; `returns forbidden payload when standalone percent encoding is detected` -> deny `/superclaw/assets/percent%.png`.

Specification traceability: `enforces decode-budget fail-closed policy for unresolved encoded octets` -> `allows high-encoded non-traversal asset path within decode budget` / `returns forbidden payload when high-encoded non-traversal asset path exceeds decode budget` -> `(self-anchor)`.

Docs link traceability: `docs/automation/autonomous-runtime.md#related-spec-anchor` -> `docs/automation/module-skill-inventory.md#webapp-encoded-path-guard-matrix` -> `(self-anchor)`.

## Verification

```bash
node --check scripts/openclaw-autonomous-inventory.mjs
pnpm autonomous:inventory:check
```
