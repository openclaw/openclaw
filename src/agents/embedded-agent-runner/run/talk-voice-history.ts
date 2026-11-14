import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { buildRunUserTurnIdempotencyKey } from "../../../sessions/user-turn-transcript.metadata.js";
import { REALTIME_VOICE_AGENT_CONSULT_INPUT_PROVENANCE } from "../../../talk/agent-consult-tool.js";
import type { AgentMessage } from "../../runtime/index.js";

function readMessageRunId(message: AgentMessage): string | undefined {
  const runId = asOptionalObjectRecord(Reflect.get(message, "__openclaw"))?.runId;
  return typeof runId === "string" && runId ? runId : undefined;
}

function isTalkRealtimeVoiceMessage(message: AgentMessage): boolean {
  if (message.role !== "user" && message.role !== "assistant") {
    return false;
  }
  const provenance = asOptionalObjectRecord(Reflect.get(message, "provenance"));
  return provenance?.kind === "realtime_voice" && provenance.sourceChannel === "talk";
}

/** The hidden prompt a Talk hand-off generated, recognizable before the run responds. */
function isTalkConsultInput(message: AgentMessage): boolean {
  if (message.role !== "user" || Reflect.get(message, "display") !== false) {
    return false;
  }
  const provenance = asOptionalObjectRecord(Reflect.get(message, "provenance"));
  return (
    provenance?.kind === REALTIME_VOICE_AGENT_CONSULT_INPUT_PROVENANCE.kind &&
    provenance.sourceTool === REALTIME_VOICE_AGENT_CONSULT_INPUT_PROVENANCE.sourceTool
  );
}

/** Generated Talk consult prompts stay model history for cache stability, never quoted speech. */
export function omitTalkConsultInputs(messages: AgentMessage[]): AgentMessage[] {
  const kept = messages.filter((message) => !isTalkConsultInput(message));
  return kept.length === messages.length ? messages : kept;
}

/**
 * Talk speech rows are appended while a consult runs, so that run's requests never contained
 * them. Replaying them in storage order would rewrite the provider prefix those requests
 * cached; moving them to just after the consult's last row keeps history append-only and
 * still gives later turns everything that was said. Other runs keep storage order.
 */
export function deferTalkSpeechInsideConsults(messages: AgentMessage[]): AgentMessage[] {
  if (!messages.some(isTalkRealtimeVoiceMessage)) {
    return messages;
  }
  const lastIndexByUserKey = new Map<string, number>();
  messages.forEach((message, index) => {
    const runId = readMessageRunId(message);
    if (runId) {
      lastIndexByUserKey.set(buildRunUserTurnIdempotencyKey(runId), index);
    }
  });
  const deferredUntil = new Map<number, AgentMessage[]>();
  const ordered: AgentMessage[] = [];
  let openUntil = -1;
  messages.forEach((message, index) => {
    const userKey = isTalkConsultInput(message)
      ? Reflect.get(message, "idempotencyKey")
      : undefined;
    if (typeof userKey === "string") {
      openUntil = Math.max(openUntil, lastIndexByUserKey.get(userKey) ?? -1);
    }
    if (index < openUntil && isTalkRealtimeVoiceMessage(message)) {
      deferredUntil.set(openUntil, [...(deferredUntil.get(openUntil) ?? []), message]);
      return;
    }
    ordered.push(message, ...(deferredUntil.get(index) ?? []));
  });
  return deferredUntil.size ? ordered : messages;
}
