function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}
function asString(value) {
  return typeof value === "string" ? value : void 0;
}
function asOptionalString(value) {
  const text = asTrimmedString(value);
  return text || void 0;
}
function asOptionalBoolean(value) {
  return typeof value === "boolean" ? value : void 0;
}
function deriveAgentFromSessionKey(sessionKey, fallbackAgent) {
  const match = sessionKey.match(/^agent:([^:]+):/i);
  const candidate = match?.[1] ? asTrimmedString(match[1]) : "";
  return candidate || fallbackAgent;
}
function buildPermissionArgs(mode) {
  if (mode === "approve-all") {
    return ["--approve-all"];
  }
  if (mode === "deny-all") {
    return ["--deny-all"];
  }
  return ["--approve-reads"];
}
export {
  asOptionalBoolean,
  asOptionalString,
  asString,
  asTrimmedString,
  buildPermissionArgs,
  deriveAgentFromSessionKey,
  isRecord
};
