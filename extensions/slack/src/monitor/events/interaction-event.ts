import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { getSlackRuntime } from "../../runtime.js";

type SessionEventOptions = Parameters<PluginRuntime["system"]["enqueueSessionEvent"]>[1];

export function enqueueSlackInteractionEvent(
  text: string,
  route: Pick<SessionEventOptions, "agentId" | "sessionKey">,
  options: Omit<SessionEventOptions, "agentId" | "sessionKey">,
  log?: (message: string) => void,
): void {
  const receipt = getSlackRuntime().system.enqueueSessionEvent(text, {
    ...options,
    agentId: route.agentId,
    sessionKey: route.sessionKey,
  });
  void receipt.settled.then((outcome) => {
    if (outcome.status !== "completed") {
      log?.(`slack:interaction follow-up ${outcome.status}: ${outcome.error ?? "cancelled"}`);
    }
  });
}
