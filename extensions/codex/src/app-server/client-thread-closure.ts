import { defineCodexBuildState } from "../build-state.js";
import type { CodexAppServerClient } from "./client.js";

/**
 * Codex emits thread/closed only after the unloaded thread's shutdown_and_wait finishes,
 * and treats shutdown as slow only after 10s (app-server thread_lifecycle.rs,
 * unload_thread_without_subscribers). Live teardown with MCP servers takes about 2s.
 */
export const CODEX_THREAD_UNLOAD_CONFIRMATION_TIMEOUT_MS = 10_000;

const MAX_CLOSED_THREAD_RECEIPTS = 256;
const closureState = defineCodexBuildState("openclaw.codexAppServerClosedThreads", () => ({
  closedThreadsByClient: new WeakMap<CodexAppServerClient, Set<string>>(),
  observedClients: new WeakSet<CodexAppServerClient>(),
}))();

function recordCodexAppServerThreadClosed(client: CodexAppServerClient, threadId: string): void {
  const receipts = closureState.closedThreadsByClient.get(client) ?? new Set<string>();
  receipts.delete(threadId);
  receipts.add(threadId);
  while (receipts.size > MAX_CLOSED_THREAD_RECEIPTS) {
    receipts.delete(receipts.values().next().value!);
  }
  closureState.closedThreadsByClient.set(client, receipts);
}

export function ensureCodexAppServerThreadClosureTracking(client: CodexAppServerClient): void {
  if (closureState.observedClients.has(client)) {
    return;
  }
  closureState.observedClients.add(client);
  client.addNotificationHandler((notification) => {
    const params = notification.params;
    const threadId =
      typeof params === "object" && params !== null && "threadId" in params
        ? params.threadId
        : undefined;
    if (notification.method === "thread/closed" && typeof threadId === "string") {
      recordCodexAppServerThreadClosed(client, threadId);
    }
  });
  client.addCloseHandler(() => closureState.closedThreadsByClient.delete(client));
}

export function clearCodexAppServerThreadClosed(
  client: CodexAppServerClient,
  threadId: string,
): void {
  closureState.closedThreadsByClient.get(client)?.delete(threadId);
}

export function wasCodexAppServerThreadClosed(
  client: CodexAppServerClient,
  threadId: string,
): boolean {
  return closureState.closedThreadsByClient.get(client)?.has(threadId) === true;
}
