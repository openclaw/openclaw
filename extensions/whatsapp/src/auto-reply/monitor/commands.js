function isStatusCommand(body) {
  const trimmed = body.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }
  return trimmed === "/status" || trimmed === "status" || trimmed.startsWith("/status ");
}
function stripMentionsForCommand(text, mentionRegexes, selfE164) {
  let result = text;
  for (const re of mentionRegexes) {
    result = result.replace(re, " ");
  }
  if (selfE164) {
    const digits = selfE164.replace(/\D/g, "");
    if (digits) {
      const pattern = new RegExp(`\\+?${digits}`, "g");
      result = result.replace(pattern, " ");
    }
  }
  return result.replace(/\s+/g, " ").trim();
}
export {
  isStatusCommand,
  stripMentionsForCommand
};
