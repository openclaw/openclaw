import type { WorkboardExecution, WorkboardStatus } from "@openclaw/workboard-contract";
import type { WorkboardStore } from "./store.js";

export async function createLinkedCard(
  store: WorkboardStore,
  options: {
    status?: WorkboardStatus;
    sessionKey?: string;
    runId?: string;
    execution?: WorkboardExecution;
    agentId?: string;
    boardId?: string;
  } = {},
) {
  return await store.create({
    title: "Gateway-owned lifecycle",
    status: options.status ?? "running",
    sessionKey: options.sessionKey,
    runId: options.runId,
    execution: options.execution,
    agentId: options.agentId,
    boardId: options.boardId,
  });
}

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
