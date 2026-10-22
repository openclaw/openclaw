import { vi } from "vitest";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";

export function createAcpMeta(overrides: Partial<SessionAcpMeta> = {}): SessionAcpMeta {
  return {
    backend: "fixture",
    agent: "main",
    runtimeSessionName: "original-runtime",
    mode: "persistent",
    state: "idle",
    lastActivityAt: 100,
    ...overrides,
  };
}

export function interceptAcpCommit(
  intercept: (execute: () => Promise<unknown>) => Promise<unknown>,
) {
  const original = stateWorker.runOpenClawStateWorkerOperation;
  return vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) =>
      original(
        context,
        (worker) =>
          operation({
            ...worker,
            execute: new Proxy(worker.execute, {
              apply(execute, receiver, args: Parameters<typeof worker.execute>) {
                const run = () => Reflect.apply(execute, receiver, args);
                return args[0].type === "acp.commitMutation" ? intercept(run) : run();
              },
            }),
          }),
        options,
      ),
    );
}
