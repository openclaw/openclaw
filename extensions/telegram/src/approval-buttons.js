const MAX_CALLBACK_DATA_BYTES = 64;
function fitsCallbackData(value) {
  return Buffer.byteLength(value, "utf8") <= MAX_CALLBACK_DATA_BYTES;
}
function buildTelegramExecApprovalButtons(approvalId) {
  return buildTelegramExecApprovalButtonsForDecisions(approvalId, [
    "allow-once",
    "allow-always",
    "deny"
  ]);
}
function buildTelegramExecApprovalButtonsForDecisions(approvalId, allowedDecisions) {
  const allowOnce = `/approve ${approvalId} allow-once`;
  if (!allowedDecisions.includes("allow-once") || !fitsCallbackData(allowOnce)) {
    return void 0;
  }
  const primaryRow = [
    { text: "Allow Once", callback_data: allowOnce }
  ];
  const allowAlways = `/approve ${approvalId} allow-always`;
  if (allowedDecisions.includes("allow-always") && fitsCallbackData(allowAlways)) {
    primaryRow.push({ text: "Allow Always", callback_data: allowAlways });
  }
  const rows = [primaryRow];
  const deny = `/approve ${approvalId} deny`;
  if (allowedDecisions.includes("deny") && fitsCallbackData(deny)) {
    rows.push([{ text: "Deny", callback_data: deny }]);
  }
  return rows;
}
export {
  buildTelegramExecApprovalButtons
};
