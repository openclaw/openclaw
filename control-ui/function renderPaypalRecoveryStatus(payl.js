function renderPaypalRecoveryStatus(payload) {
  const marketSnapshot = payload && typeof payload === "object" ? payload : {};
  const recovery =
    marketSnapshot.paypalRecovery && typeof marketSnapshot.paypalRecovery === "object"
      ? marketSnapshot.paypalRecovery
      : {};
  const empire =
    marketSnapshot.empire && typeof marketSnapshot.empire === "object" ? marketSnapshot.empire : {};
  const summary =
    marketSnapshot.summary && typeof marketSnapshot.summary === "object"
      ? marketSnapshot.summary
      : {};
  const market =
    marketSnapshot.market && typeof marketSnapshot.market === "object" ? marketSnapshot.market : {};
  const database =
    marketSnapshot.database && typeof marketSnapshot.database === "object"
      ? marketSnapshot.database
      : {};

  state.empireMarket = marketSnapshot;

  const aprValue = Number(recovery.apr);
  const daysRemaining = Number(recovery.daysRemaining);

  setText("paypal-target-value", recovery.targetValueDisplay || "--", "tone-ok");
  setText(
    "paypal-countdown",
    recovery.countdownLabel || "--",
    Number.isFinite(daysRemaining) ? (daysRemaining > 0 ? "tone-warn" : "tone-ok") : "",
  );
  setText(
    "paypal-target-date",
    formatLocalTimestamp(recovery.targetDate) || recovery.targetDate || "--",
  );
  setText("paypal-principal", recovery.principalDisplay || "--");
  setText(
    "paypal-interest",
    recovery.accruedInterestDisplay || "--",
    Number(recovery.accruedInterestEur) > 0 ? "tone-ok" : "",
  );
  setText("paypal-apr", Number.isFinite(aprValue) ? `${(aprValue * 100).toFixed(2)}%` : "--");

  const detailLines = [
    summary.totalNetWorthDisplay
      ? `Net worth with recovery: ${summary.totalNetWorthDisplay}`
      : null,
    market.summary?.totalValueDisplay
      ? `Crypto baseline: ${market.summary.totalValueDisplay}`
      : null,
    empire.lastUpdated ? `Last updated: ${formatLocalTimestamp(empire.lastUpdated)}` : null,
    typeof database.connected === "boolean"
      ? `Database: ${database.connected ? "connected" : "offline"} · Persistence: ${database.persistenceReady ? "ready" : "not ready"}`
      : null,
    empire.lastError
      ? `Status: ${empire.lastError}`
      : `Source: ${market.source || empire.source || "backend snapshot"}`,
  ].filter(Boolean);

  document.getElementById("paypal-recovery-detail").textContent = detailLines.join("\n");
}
