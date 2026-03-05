import { registerCommandHandler } from "../process/command-queue.js";
import { runEmbeddedPiAgent } from "./pi-embedded-runner/run.js";
import { compactEmbeddedPiSessionDirect } from "./pi-embedded-runner/compact.js";

export function initializeAgentHandlers() {
  registerCommandHandler("EMBEDDED_PI_RUN", async (payload: any) => {
    if (!payload.enqueue) {
      payload.enqueue = <T>(_taskType: string, _p: any, _opts?: any): Promise<T> => {
        return Promise.resolve(undefined as T);
      };
    }
    const result = await runEmbeddedPiAgent(payload);
    return result;
  });

  registerCommandHandler("EMBEDDED_PI_COMPACT", async (payload: any) => {
    return compactEmbeddedPiSessionDirect(payload);
  });
}
