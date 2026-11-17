import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";

/** One page's invalidation subscription; reads are serialized within a connection. */
export function observePeople(
  host: ControlUiHost,
  read: (isCurrent: () => boolean) => Promise<void>,
) {
  let disposed = false;
  let connected = host.connection.connected;
  let generation = 0;
  let inFlight: Promise<void> | undefined;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancelTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  // A read invalidated while in flight is followed by one fresh read, never a lost event.
  const refresh = (): Promise<void> => {
    if (disposed || host.signal.aborted || !connected) {
      return Promise.resolve();
    }
    cancelTimer();
    if (inFlight) {
      pending = true;
      return inFlight;
    }
    pending = false;
    const current = generation;
    const isCurrent = () => !disposed && !host.signal.aborted && current === generation;
    const request = read(isCurrent).finally(() => {
      if (!isCurrent()) {
        return;
      }
      inFlight = undefined;
      if (pending && timer === undefined) {
        void refresh();
      }
    });
    inFlight = request;
    return request;
  };

  const stopEvents = host.onEvent("openclawId.people.changed", () => {
    if (disposed || !connected || host.signal.aborted) {
      return;
    }
    pending = true;
    cancelTimer();
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, 250);
  });
  const stopConnection = host.subscribe(() => {
    if (connected === host.connection.connected) {
      return;
    }
    connected = host.connection.connected;
    // A retired transport must not publish into its successor or delay reconnect recovery.
    generation += 1;
    inFlight = undefined;
    pending = false;
    cancelTimer();
    if (connected) {
      void refresh();
    }
  });
  void refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      generation += 1;
      cancelTimer();
      stopEvents();
      stopConnection();
    },
  };
}
