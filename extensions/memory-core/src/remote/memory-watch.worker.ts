import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { MessagePort } from "node:worker_threads";
import { formatErrorMessage, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { MemoryFileWatcher } from "../memory/file-watcher.js";
import type { LocalWatchCommand, LocalWatchEvent } from "../memory/local-watch-protocol.js";

type LocalWatch = {
  id: number;
  watcher: MemoryFileWatcher;
  closing?: Promise<void>;
};

/** Dedicated local transport; all subscriptions retain the watcher's shared-root owner. */
export function serveLocalMemoryWatches(port: MessagePort): Promise<void> {
  const runInBackgroundContext = AsyncLocalStorage.snapshot();
  const watches = new Map<number, LocalWatch>();
  const closeErrors: unknown[] = [];
  let portClosed = false;
  let shutdown: Promise<void> | undefined;
  return new Promise<void>((resolve, reject) => {
    const send = (event: LocalWatchEvent) => {
      if (!portClosed) {
        port.postMessage(event);
      }
    };
    const closeWatch = (entry: LocalWatch, startError?: unknown): Promise<void> => {
      if (entry.closing) {
        return entry.closing;
      }
      // close stops admission immediately, even while start is discovering roots.
      let retirement: Promise<void>;
      try {
        retirement = entry.watcher.close();
      } catch (error) {
        retirement = Promise.reject(toErrorObject(error, "Memory file watcher close failed"));
      }
      return (entry.closing = retirement.then(
        () => {
          watches.delete(entry.id);
          send({
            type: "closed",
            id: entry.id,
            ...(startError === undefined ? {} : { error: formatErrorMessage(startError) }),
          });
        },
        (error: unknown) => {
          closeErrors.push(error);
          watches.delete(entry.id);
          send({ type: "closed", id: entry.id, error: String(error) });
        },
      ));
    };
    const stop = (): Promise<void> => {
      port.off("message", onMessage);
      return (shutdown ??= Promise.all(
        [...watches.values()].map((entry) => closeWatch(entry)),
      ).then(() => {
        const error = closeErrors.length
          ? new AggregateError(closeErrors, "Local Memory watcher retirement failed")
          : undefined;
        send({ type: "shutdown", ...(error ? { error: String(error) } : {}) });
        port.off("close", onPortClose);
        port.close();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }));
    };
    const onPortClose = () => {
      portClosed = true;
      void stop();
    };
    const onMessage = (command: LocalWatchCommand) => {
      switch (command.type) {
        case "open": {
          const { id, request } = command;
          const watcher = new MemoryFileWatcher({
            runInBackgroundContext,
            workspaceDir: path.resolve(command.workspaceDir),
            agentId: request.agentId,
            settings: request.settings,
            onDirty: () => send({ type: "dirty", id }),
            onChange: () => send({ type: "change", id }),
            onUnavailable: () => send({ type: "unavailable", id }),
            onState: (facts) => send({ type: "state", id, facts }),
          });
          const entry: LocalWatch = { id, watcher };
          watches.set(id, entry);
          void watcher.start().then(
            () => {
              if (!entry.closing) {
                send({
                  type: "started",
                  id,
                  facts: { health: watcher.health(), capacityDegraded: watcher.capacityDegraded },
                });
              }
            },
            (error: unknown) => closeWatch(entry, error),
          );
          break;
        }
        case "close": {
          const entry = watches.get(command.id);
          if (entry) {
            void closeWatch(entry);
          } else {
            send({ type: "closed", id: command.id });
          }
          break;
        }
        case "shutdown":
          void stop();
          break;
      }
    };
    port.on("message", onMessage);
    port.once("close", onPortClose);
  });
}
