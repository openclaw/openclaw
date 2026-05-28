import { buildCapitalLiveOrderDryRunPretradeGate } from "./openclaw-capital-live-order-dry-run-pretrade-gate.mjs";

const report = await buildCapitalLiveOrderDryRunPretradeGate({ repoRoot: process.cwd() });
const issues = [];
const legacyDomesticOrderSymbols = new Set(["TX00AM", "TX00PM", "TX06AM", "TX06PM"]);
const isTrue = (value) => value === true;
const isFalse = (value) => value === false;

if (report.schema !== "openclaw.capital.live-order-dry-run-pretrade-gate.v1") {
  issues.push("schema mismatch");
}
if (report.status !== "live_order_dry_run_pretrade_blocked") {
  issues.push(`status=${report.status}`);
}
if (report.decision !== "quarantine_only_do_not_send") {
  issues.push("decision mismatch");
}
if (!isTrue(report.preTradeRiskGate?.attachedBeforeBrokerSend)) {
  issues.push("pre-trade risk gate not attached before broker send");
}
if (
  !isTrue(report.preTradeRiskGate?.evaluated) ||
  !isFalse(report.preTradeRiskGate?.allowedToSend)
) {
  issues.push("pre-trade risk gate must be evaluated and blocked");
}
if (
  !Array.isArray(report.preTradeRiskGate?.blockers) ||
  report.preTradeRiskGate.blockers.length <= 0
) {
  issues.push("expected live blockers");
}
if (!isFalse(report.safety?.liveTradingEnabled) || !isFalse(report.safety?.writeBrokerOrders)) {
  issues.push("live writes must stay disabled");
}
if (
  !isFalse(report.safety?.brokerCommandFileWrite) ||
  !isTrue(report.safety?.brokerCommandSuppressed)
) {
  issues.push("broker command suppression mismatch");
}
if (!isFalse(report.safety?.sentOrder) || !isTrue(report.safety?.noLiveOrderSent)) {
  issues.push("sent order safety mismatch");
}
if (!isTrue(report.safety?.quarantineOnly)) {
  issues.push("quarantineOnly must be true");
}
if (report.operatorHandoff?.schema !== "openclaw.capital.operator-handoff.v1") {
  issues.push("operator handoff missing");
}
if (
  !isFalse(report.operatorHandoff?.automatedBrokerWriteAllowed) ||
  !isFalse(report.operatorHandoff?.operatorMustUseBrokerUi)
) {
  issues.push("operator handoff must keep Codex/OpenClaw broker-write disabled");
}
if (
  !isTrue(report.operatorHandoff?.operatorOwnedBrokerAdapterAllowed) ||
  !isTrue(report.operatorHandoff?.externalBrokerAdapter?.required)
) {
  issues.push("operator-owned broker adapter contract missing");
}
if (!report.operatorHandoff?.externalBrokerAdapter?.ack?.path) {
  issues.push("external broker adapter ack path missing");
}
if (
  report.operatorHandoff?.externalBrokerAdapter?.ack?.template?.rollback?.verifiedAt === "ISO-8601"
) {
  issues.push("external adapter ack template rollback verifiedAt must not be placeholder");
}
if (
  report.operatorHandoff?.externalBrokerAdapter?.ack?.rollbackVerifiedAt &&
  report.operatorHandoff.externalBrokerAdapter.ack.template?.rollback?.verifiedAt !==
    report.operatorHandoff.externalBrokerAdapter.ack.rollbackVerifiedAt
) {
  issues.push("external adapter ack template rollback verifiedAt mismatch");
}
if (
  report.operatorHandoff?.externalBrokerAdapter?.ack?.usable === true &&
  report.operatorHandoff?.externalBrokerAdapter?.ack?.status !== "verified"
) {
  issues.push("usable external adapter ack must be verified");
}
if (
  report.operatorHandoff?.handoffPacket?.sealedOrderIntent?.brokerWriteAllowedByOpenClaw !== false
) {
  issues.push("sealed order intent must not allow OpenClaw broker write");
}
if (!report.operatorHandoff?.handoffPacket?.sealedOrderIntent?.sha256) {
  issues.push("sealed order intent hash missing");
}
if (
  report.operatorHandoff?.externalBrokerAdapter?.ack?.requiredSealedIntentSha256 !==
  report.operatorHandoff?.handoffPacket?.sealedOrderIntent?.sha256
) {
  issues.push("external adapter ack must reference sealed intent hash");
}
const positionDecisionStatuses = new Set([
  "blocked_no_verified_position_snapshot",
  "verified_flat_no_exit_required",
  "verified_open_position_auto_exit_eligible",
]);
if (!positionDecisionStatuses.has(report.operatorHandoff?.positionDecision?.status)) {
  issues.push("position decision status invalid");
}
if (!report.operatorHandoff?.positionSnapshot?.path) {
  issues.push("position snapshot input path missing");
}
if (
  report.operatorHandoff?.positionSnapshot?.usable === true &&
  report.operatorHandoff?.positionDecision?.status === "blocked_no_verified_position_snapshot"
) {
  issues.push("position decision must use verified snapshot when available");
}
if (
  !Array.isArray(report.operatorHandoff?.validationCommands) ||
  report.operatorHandoff.validationCommands.length <= 0
) {
  issues.push("operator handoff validation commands missing");
}
if (!["SendFutureOrder", "SendOverseaFutureOrder"].includes(report.liveOrderDraft?.brokerApi)) {
  issues.push("broker api mapping missing");
}
if (!["FUTUREORDER", "OVERSEAFUTUREORDER"].includes(report.liveOrderDraft?.brokerStruct)) {
  issues.push("broker struct missing");
}
if (!report.liveOrderDraft?.commandPayload?.stockNo) {
  issues.push("stockNo missing");
}
if (
  legacyDomesticOrderSymbols.has(
    (report.liveOrderDraft?.commandPayload?.stockNo || "").toUpperCase(),
  )
) {
  issues.push("legacy domestic order symbol must be rewritten before broker draft");
}
if (
  legacyDomesticOrderSymbols.has(
    (report.liveOrderDraft?.brokerFields?.bstrStockNo || "").toUpperCase(),
  )
) {
  issues.push("legacy domestic broker field symbol must be rewritten");
}
if (
  legacyDomesticOrderSymbols.has(
    (report.liveOrderDraft?.symbolRoute?.sourceSymbol || "").toUpperCase(),
  ) &&
  report.liveOrderDraft?.symbolRoute?.route !== "legacy_domestic_alias_rewritten"
) {
  issues.push("legacy domestic source symbol rewrite route missing");
}
if ((report.liveOrderDraft?.commandPayload?.qty ?? 0) <= 0) {
  issues.push("qty missing");
}
if ((report.liveOrderDraft?.accountAllowlist?.count ?? 0) <= 0) {
  issues.push("account allowlist summary missing");
}
if (
  !Array.isArray(report.liveOrderDraft?.supportedModes) ||
  report.liveOrderDraft.supportedModes.length !== 2
) {
  issues.push("day trade / overnight modes missing");
}
if (
  report.liveOrderDraft?.commandPayload?.dayTradeMode === "explicit_required" &&
  !report.preTradeRiskGate.blockers.includes("order:day-trade-mode-explicit-required")
) {
  issues.push("explicit day-trade mode blocker missing");
}

if (issues.length > 0) {
  process.stderr.write(
    `CAPITAL_LIVE_ORDER_DRY_RUN_PRETRADE_CHECK=FAIL issues=${issues.join(";")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `CAPITAL_LIVE_ORDER_DRY_RUN_PRETRADE_CHECK=OK status=${report.status} api=${report.liveOrderDraft.brokerApi} struct=${report.liveOrderDraft.brokerStruct} symbol=${report.liveOrderDraft.commandPayload.stockNo} allowedToSend=${report.preTradeRiskGate.allowedToSend} sentOrder=${report.safety.sentOrder} blockers=${report.preTradeRiskGate.blockerCount}\n`,
  );
}
