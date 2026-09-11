import {
  embeddedAgentLog,
  emitAgentEvent,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";

type AgentEvent = Parameters<NonNullable<EmbeddedRunAttemptParamsV2["onAgentEvent"]>>[0];

export type CodexAgentEventBinding = Readonly<{
  publish: (event: AgentEvent) => boolean;
  onAgentEvent: EmbeddedRunAttemptParamsV2["onAgentEvent"];
}>;

/** Negotiate once, before preparation yields; later params mutation cannot switch publishers. */
export function captureCodexAgentEventBinding(
  params: EmbeddedRunAttemptParamsV2,
): CodexAgentEventBinding {
  const { publishAgentEvent } = params.hostCapabilities;
  const { runId, sessionKey, onAgentEvent } = params;
  return Object.freeze({
    onAgentEvent,
    publish: (event) => {
      if (publishAgentEvent) {
        try {
          publishAgentEvent(event);
          return true;
        } catch {
          embeddedAgentLog.debug("codex app-server admitted agent event publication rejected");
          return false;
        }
      }
      // Released plugins also run on older hosts. Only captured absence selects the legacy sink.
      try {
        emitAgentEvent({
          runId,
          stream: event.stream,
          data: event.data,
          ...(sessionKey ? { sessionKey } : {}),
        });
      } catch (error) {
        embeddedAgentLog.debug("codex app-server global agent event emit failed", { error });
      }
      return true;
    },
  });
}
