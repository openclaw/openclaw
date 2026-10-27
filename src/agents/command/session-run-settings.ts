import type { SessionEntry } from "../../config/sessions/types.js";

/** Session-scoped settings every embedded turn of the session runs with. */
export function readSessionRunSettings(
  entry: Pick<SessionEntry, "permissionMode" | "sessionRoot" | "blindPrompt"> | undefined,
) {
  return {
    permissionMode: entry?.permissionMode,
    sessionRoot: entry?.sessionRoot,
    blindPrompt: entry?.blindPrompt,
  };
}
