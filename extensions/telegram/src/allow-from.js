function normalizeTelegramAllowFromEntry(raw) {
  const base = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
  return base.trim().replace(/^(telegram|tg):/i, "").trim();
}
function isNumericTelegramUserId(raw) {
  return /^-?\d+$/.test(raw);
}
export {
  isNumericTelegramUserId,
  normalizeTelegramAllowFromEntry
};
