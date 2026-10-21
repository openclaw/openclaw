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
    ...options,
    title: "Gateway-owned lifecycle",
    status: options.status ?? "running",
  });
}
