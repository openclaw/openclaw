import { EmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.run-state.js";

export function createBaseToolHandlerState() {
  return new EmbeddedAgentSubscribeState({});
}
