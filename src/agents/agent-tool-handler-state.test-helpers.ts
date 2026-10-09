import { createEmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.run-state.js";

export function createBaseToolHandlerState() {
  return createEmbeddedAgentSubscribeState({});
}
