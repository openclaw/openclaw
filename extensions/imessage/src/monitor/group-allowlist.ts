import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseIMessageAllowTarget } from "../targets.js";

function isIMessageConversationAllowTarget(entry: string): boolean {
  const parsed = parseIMessageAllowTarget(entry);
  return (
    parsed.kind === "chat_id" || parsed.kind === "chat_guid" || parsed.kind === "chat_identifier"
  );
}

// Shared by the runtime group gate and the startup allowlist warning so the
// warning only fires when the gate would actually drop every group message.
export function mergeIMessageGroupAllowFromWithLegacyChatTargets(params: {
  groupAllowFrom: string[];
  allowFrom: string[];
  allowLegacyConversationTargets?: boolean;
}): string[] {
  if (params.groupAllowFrom.length > 0 || !params.allowLegacyConversationTargets) {
    return params.groupAllowFrom;
  }
  const legacyChatTargets = params.allowFrom.filter((entry) =>
    isIMessageConversationAllowTarget(entry),
  );
  if (legacyChatTargets.length === 0) {
    return params.groupAllowFrom;
  }
  return uniqueStrings([...params.groupAllowFrom, ...legacyChatTargets]);
}
