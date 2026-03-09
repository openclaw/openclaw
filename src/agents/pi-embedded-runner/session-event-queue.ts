const DEFAULT_EVENT_QUEUE_DRAIN_TIMEOUT_MS = 5_000;

// pi-coding-agent does not expose a public "drain pending session persistence" API.
// Its event queue is the last barrier before transcript/session writes settle.
type AgentSessionWithEventQueue = {
  _agentEventQueue?: Promise<unknown>;
};

export async function waitForAgentSessionEventQueue(params: {
  session: AgentSessionWithEventQueue | null | undefined;
  timeoutMs?: number;
  onTimeout?: () => void;
}): Promise<void> {
  const queue = params.session?._agentEventQueue;
  if (!queue || typeof queue.then !== "function") {
    return;
  }

  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(0, Math.floor(params.timeoutMs))
      : DEFAULT_EVENT_QUEUE_DRAIN_TIMEOUT_MS;

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve(queue).catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          params.onTimeout?.();
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
