export type VerbCategory = "read" | "write" | "delete" | "export" | "unknown";

const VERB_PATTERNS: Record<VerbCategory, string[]> = {
  read: ["get", "list", "search", "fetch", "query", "read", "find", "lookup", "check"],
  write: ["create", "update", "send", "add", "set", "write", "put", "patch", "post", "reply"],
  delete: ["delete", "remove", "revoke", "cancel", "unsubscribe", "purge", "clear", "trash"],
  export: ["forward", "share", "transfer", "export", "copy-to", "copy", "move", "migrate"],
  unknown: [],
};

/**
 * Extract the verb portion from a tool name and classify it.
 *
 * Supports formats like:
 * - "email.delete" → verb is "delete"
 * - "deleteFile" → verb is extracted from camelCase prefix
 * - "email.DELETE" → case-insensitive
 */
export function classifyVerb(toolName: string): VerbCategory {
  const lower = toolName.toLowerCase();

  // Try dotted format: "namespace.verb" or "namespace.verbNoun"
  const dotIndex = lower.lastIndexOf(".");
  const actionPart = dotIndex >= 0 ? lower.slice(dotIndex + 1) : lower;

  for (const [category, verbs] of Object.entries(VERB_PATTERNS) as [VerbCategory, string[]][]) {
    if (category === "unknown") continue;
    for (const verb of verbs) {
      if (actionPart === verb || actionPart.startsWith(verb)) {
        return category;
      }
    }
  }

  return "unknown";
}

/**
 * Map verb category to default tier.
 */
export function verbToDefaultTier(verb: VerbCategory): "allow" | "confirm" {
  switch (verb) {
    case "read":
      return "allow";
    case "write":
      return "allow"; // Known targets. Unknown targets escalated by rules engine.
    case "delete":
      return "confirm";
    case "export":
      return "confirm";
    case "unknown":
      return "confirm";
  }
}
