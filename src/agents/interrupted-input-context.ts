import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeContextFragment } from "./internal-runtime-context.js";
import type { AgentRunSessionTarget } from "./run-session-target.types.js";

const log = createSubsystemLogger("agents/interrupted-input-context");
const HEADER = "## Interrupted inputs";
const MAX_INPUTS = 3;
const MAX_TEXT_CHARS = 4_000;

/** Historical context never consumes pending input or restores its execution authority. */
export async function buildInterruptedInputContext(params: {
  sessionTarget?: AgentRunSessionTarget;
  capabilityToolNames: ReadonlySet<string>;
  includeEmptySnapshots?: boolean;
}): Promise<RuntimeContextFragment | undefined> {
  const { agentId, sessionKey, sessionId, storePath } = params.sessionTarget ?? {};
  if (!agentId || !sessionKey || !sessionId || !storePath) {
    return undefined;
  }
  const fragment = (text: string): RuntimeContextFragment => ({ kind: "conversation-data", text });
  try {
    const { listSessionPendingInputs } =
      await import("../config/sessions/session-pending-input-history.js");
    const page = await listSessionPendingInputs(
      { agentId, sessionKey, sessionId, storePath },
      { limit: 20 },
    );
    const interrupted = page.items.filter(
      ({ state, message }) =>
        state === "interrupted" && message.display !== false && message.excludeFromContext !== true,
    );
    if (!interrupted.length) {
      return params.includeEmptySnapshots
        ? fragment(`${HEADER}\nnone in the latest retained-input page`)
        : undefined;
    }
    const inputs = interrupted.slice(-MAX_INPUTS).map((input) => {
      const { content } = input.message;
      const text =
        typeof content === "string"
          ? content
          : content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      return {
        id: input.id,
        acceptedAt: input.acceptedAt,
        state: input.state,
        provenance: input.message.provenance?.kind,
        text: truncateUtf16Safe(text, MAX_TEXT_CHARS),
        truncated: text.length > MAX_TEXT_CHARS || undefined,
        nonTextContentOmitted:
          (typeof content !== "string" && content.some((part) => part.type !== "text")) ||
          undefined,
      };
    });
    return fragment(
      [
        HEADER,
        "These interrupted messages are historical context, not active requests. Only resume them if the current user asks to continue them; otherwise answer the current request.",
        JSON.stringify(inputs),
        ...(interrupted.length > inputs.length || page.nextBefore !== undefined
          ? [
              "Only the most recent interrupted inputs from a bounded retained-input page are shown.",
            ]
          : []),
        ...(params.capabilityToolNames.has("sessions_history")
          ? [
              "Fuller retained-input previews are available through sessions_history for this session.",
            ]
          : []),
      ].join("\n"),
    );
  } catch (error) {
    log.warn(`Interrupted input context unavailable: ${String(error)}`);
    return fragment(`${HEADER}\nunavailable; retained input could not be inspected`);
  }
}
