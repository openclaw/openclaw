import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CodexHistoryRejection,
  codexHistoryRejectionReason,
  type CodexHistoryRejectionReason,
} from "./history-rejection.js";
import type { JsonValue } from "./protocol.js";
import type { CodexMirroredSessionHistoryTarget } from "./session-history.js";
import type { SettledTurnMessages } from "./settled-turn-evidence.js";

function freezeProjection(value: JsonValue): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeProjection(child);
    }
    Object.freeze(value);
  }
}

type CodexSettledTurnSelection = {
  model: string;
  modelProvider?: string;
  authProfileId?: string;
};

/** Only the Codex owner interprets this bounded, detached replay projection. */
export class CodexSettledTurnContext {
  readonly source = "harness";

  constructor(
    readonly data: JsonValue[],
    readonly selection: CodexSettledTurnSelection,
  ) {
    freezeProjection(data);
    Object.freeze(selection);
    Object.freeze(this);
  }
}

/** Verifies and freezes a complete replay projection while reading the active branch. */
export async function captureCodexSettledTurnFinalizationContext(
  params: CodexMirroredSessionHistoryTarget &
    SettledTurnMessages &
    Partial<CodexSettledTurnSelection> & { signal?: AbortSignal; assertActive?: () => void },
): Promise<CodexSettledTurnContext | undefined> {
  let reason: CodexHistoryRejectionReason;
  let stage: "before_read" | "load_worker" | "read" | "after_read" = "before_read";
  try {
    params.signal?.throwIfAborted();
    params.assertActive?.();
    const { model, modelProvider, authProfileId } = params;
    if (!model) {
      throw new CodexHistoryRejection("model_unavailable");
    }
    stage = "load_worker";
    const { projectCodexSettledHistoryInWorker } =
      await import("../../session-history-worker-runtime.js");
    stage = "read";
    const result = await projectCodexSettledHistoryInWorker(params, params.signal);
    stage = "after_read";
    params.signal?.throwIfAborted();
    params.assertActive?.();
    if (result.status === "ok") {
      return new CodexSettledTurnContext(result.value, { model, modelProvider, authProfileId });
    }
    reason = result.reason;
    stage = "read";
  } catch (error) {
    reason = params.signal?.aborted ? "cancelled" : codexHistoryRejectionReason(error);
  }
  // Capture follows settled side effects; a rejected read must preserve the incomplete turn.
  embeddedAgentLog.warn("codex settled-turn finalization context capture failed", {
    reason,
    ...(reason === "history_read_failed" ? { stage } : {}),
  });
  return undefined;
}
