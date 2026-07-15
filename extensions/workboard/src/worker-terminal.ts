// Workboard worker terminal reconciliation fails closed when a worker exits
// without committing its claimed card through the lifecycle tools.
import { WorkboardStore } from "./store.js";

type WorkboardRunEndEvent = {
  runId?: string;
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  error?: string;
};

function terminalReason(event: WorkboardRunEndEvent): string {
  if (event.outcome === "ok") {
    return "Worker ended normally without successfully completing or blocking its Workboard card.";
  }
  const detail = event.error?.trim();
  return detail
    ? `Worker ended abnormally (${event.outcome ?? "error"}): ${detail}`
    : `Worker ended abnormally (${event.outcome ?? "error"}).`;
}

export async function reconcileWorkboardRunEnd(params: {
  store: WorkboardStore;
  event: WorkboardRunEndEvent;
}): Promise<void> {
  const runId = params.event.runId?.trim();
  if (!runId) {
    return;
  }
  const card = (await params.store.list()).find((candidate) => candidate.runId === runId);
  if (!card) {
    return;
  }
  const lifecycleCommitted =
    !card.metadata?.claim &&
    (card.status === "review" || card.status === "done" || card.status === "blocked");
  if (lifecycleCommitted) {
    return;
  }
  await params.store.block(card.id, { reason: terminalReason(params.event) }, null);
}
