import type { StreamFn } from "@mariozechner/pi-agent-core";
import { log } from "./pi-embedded-runner/logger.js";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class CopilotInitiatorTracker {
  #firstCallMade = new Set<string>();
  #sessionTimestamps = new Map<string, number>();

  getInitiator(sessionId: string): "user" | "agent" {
    if (this.#firstCallMade.has(sessionId)) {
      return "agent";
    }
    this.#firstCallMade.add(sessionId);
    this.#sessionTimestamps.set(sessionId, Date.now());
    return "user";
  }

  reset(sessionId: string): void {
    this.#firstCallMade.delete(sessionId);
    this.#sessionTimestamps.delete(sessionId);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [sessionId, timestamp] of this.#sessionTimestamps) {
      if (now - timestamp > CLEANUP_INTERVAL_MS) {
        this.#firstCallMade.delete(sessionId);
        this.#sessionTimestamps.delete(sessionId);
      }
    }
  }
}

export function createCopilotAwareStream(
  provider: string,
  sessionId: string,
  tracker: CopilotInitiatorTracker,
  originalStreamSimple: StreamFn,
  config?: { disableInitiatorHeader?: boolean },
): StreamFn {
  return async function streamWithInitiatorHeader(model, context, options) {
    const headers = { ...options?.headers };

    if (provider === "github-copilot" && !config?.disableInitiatorHeader) {
      const initiator = tracker.getInitiator(sessionId);
      headers["X-Initiator"] = initiator;
      log.debug(`copilot x-initiator: sessionId=${sessionId} initiator=${initiator}`);
    }

    return originalStreamSimple(model, context, { ...options, headers });
  };
}

export const copilotInitiatorTracker = new CopilotInitiatorTracker();
