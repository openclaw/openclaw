import type { StreamFn } from "@mariozechner/pi-agent-core";

export class CopilotInitiatorTracker {
  #firstCallMade = new Set<string>();

  getInitiator(sessionId: string): "user" | "agent" {
    if (this.#firstCallMade.has(sessionId)) {
      return "agent";
    }
    this.#firstCallMade.add(sessionId);
    return "user";
  }

  reset(sessionId: string): void {
    this.#firstCallMade.delete(sessionId);
  }
}

export function createCopilotAwareStream(
  provider: string,
  sessionId: string,
  tracker: CopilotInitiatorTracker,
  originalStreamSimple: StreamFn,
): StreamFn {
  return async function streamWithInitiatorHeader(model, context, options) {
    const headers = { ...options?.headers };

    if (provider === "github-copilot") {
      const initiator = tracker.getInitiator(sessionId);
      headers["X-Initiator"] = initiator;
    }

    return originalStreamSimple(model, context, { ...options, headers });
  };
}

export const copilotInitiatorTracker = new CopilotInitiatorTracker();
