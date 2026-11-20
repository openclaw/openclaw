import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  omitRecordedModelPrompt,
  readModelPromptProjection,
} from "../../sessions/user-turn-transcript.message.js";
import type { AgentMessage } from "../runtime/index.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";

export const SYSTEM_PROMPT_UPDATE_HEADER =
  "System prompt update. The sections below replace their earlier versions; everything else in the system prompt is unchanged.";

/**
 * A worker turn carries its prompt delta on its own user row (model-only text). A rebuild
 * already contains every delta, so rows before the newest rebuild stop replaying theirs,
 * as prompt-update rows do. Both runtimes apply this, so a moved session honors rebuilds.
 */
export function retireUserRowPromptUpdates(
  messages: AgentMessage[],
  entries: readonly SessionEntry[],
  restart: boolean,
): AgentMessage[] {
  const rebuild = restart
    ? Infinity
    : Date.parse(
        entries.findLast(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "openclaw.system-prompt" &&
            isRecord(entry.data) &&
            entry.data.restart === true,
        )?.timestamp ?? "",
      );
  let changed = false;
  const retained = messages.map((message) => {
    if (
      message.role !== "user" ||
      !(message.timestamp < rebuild) ||
      !readModelPromptProjection(message)?.startsWith(SYSTEM_PROMPT_UPDATE_HEADER)
    ) {
      return message;
    }
    changed = true;
    return omitRecordedModelPrompt(message);
  });
  return changed ? retained : messages;
}
