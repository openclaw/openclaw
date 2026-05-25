if (empireMarketResult.status === "fulfilled") {
  const payload = await readJsonPayload(empireMarketResult.value);

  if (payload && typeof payload === "object" && empireMarketResult.value.ok) {
    renderPaypalRecoveryStatus(payload);
  } else if (payload && typeof payload === "object") {
    document.getElementById("paypal-recovery-detail").textContent =
      payload.detail ||
      payload.error ||
      `PayPal recovery status failed with HTTP ${empireMarketResult.value.status}.`;
  }
}
