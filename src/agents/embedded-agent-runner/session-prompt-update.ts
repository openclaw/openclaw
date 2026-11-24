import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  omitRecordedModelPrompt,
  prepareModelPromptProjection,
  readModelPromptProjection,
} from "../../sessions/user-turn-transcript.message.js";
import { getOpenClawSystemUpdateKind } from "../internal-runtime-context.js";
import type { AgentMessage } from "../runtime/index.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";

export const SYSTEM_PROMPT_UPDATE_HEADER =
  "System prompt update. The sections below replace their earlier versions; everything else in the system prompt is unchanged.";

/**
 * A worker turn appends its prompt delta to its own user row (model-only text). A rebuild
 * already contains every delta, so rows before the newest rebuild stop replaying theirs and
 * the rebuilding request drops prompt-update rows. Both runtimes apply this, so a moved
 * session honors rebuilds. Other model-only text on the row stays.
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
  const retained = messages.flatMap((message): AgentMessage[] => {
    if (restart && getOpenClawSystemUpdateKind(message) === "prompt-update") {
      changed = true;
      return [];
    }
    if (message.role !== "user" || !(message.timestamp < rebuild)) {
      return [message];
    }
    const projection = readModelPromptProjection(message);
    const at = projection?.lastIndexOf(`\n\n${SYSTEM_PROMPT_UPDATE_HEADER}`) ?? -1;
    if (projection === undefined || at < 0) {
      return [message];
    }
    changed = true;
    const rest = projection.slice(0, at);
    const retired = omitRecordedModelPrompt(message);
    const shown =
      typeof message.content === "string"
        ? message.content
        : message.content.find((block) => block.type === "text")?.text;
    return [(rest === shown ? undefined : prepareModelPromptProjection(retired, rest)) ?? retired];
  });
  return changed ? retained : messages;
}
