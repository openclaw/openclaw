const TERMINAL_PROVIDER_STATUS_TO_END_REASON = {
  completed: "completed",
  failed: "failed",
  busy: "busy",
  "no-answer": "no-answer",
  canceled: "hangup-bot"
};
function normalizeProviderStatus(status) {
  const normalized = status?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}
function mapProviderStatusToEndReason(status) {
  const normalized = normalizeProviderStatus(status);
  return TERMINAL_PROVIDER_STATUS_TO_END_REASON[normalized] ?? null;
}
function isProviderStatusTerminal(status) {
  return mapProviderStatusToEndReason(status) !== null;
}
export {
  isProviderStatusTerminal,
  mapProviderStatusToEndReason,
  normalizeProviderStatus
};
