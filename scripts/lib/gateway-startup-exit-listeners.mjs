// Observe registration without adding an exit listener or changing Node's warning limit.
import { defaultMaxListeners } from "node:events";
import { isMainThread } from "node:worker_threads";

if (isMainThread && process.send) {
  const defaultLimit = defaultMaxListeners;
  const registrations = [];
  const warnings = [];
  const active = new Map();
  let peak = process.listenerCount("exit");
  const onNewListener = (event, listener) => {
    if (event !== "exit") {
      return;
    }
    // newListener fires before Node inserts the listener, including once wrappers.
    const previousStackLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 30;
    const stack = new Error("process exit registration").stack;
    Error.stackTraceLimit = previousStackLimit;
    const registration = {
      name: listener.name,
      stack,
      count: process.listenerCount("exit") + 1,
      removed: false,
    };
    registrations.push(registration);
    const entries = active.get(listener) ?? [];
    entries.push(registration);
    active.set(listener, entries);
    peak = Math.max(peak, registration.count);
  };
  const onRemoveListener = (event, listener) => {
    if (event !== "exit") {
      return;
    }
    const entries = active.get(listener.listener ?? listener);
    const registration = entries?.pop();
    if (registration) {
      registration.removed = true;
    }
  };
  const onWarning = (warning) => {
    warnings.push({ name: warning.name, message: warning.message, stack: warning.stack });
  };
  const onMessage = (message) => {
    if (message?.type !== "openclaw-startup-exit-listeners:capture") {
      return;
    }
    process.off("newListener", onNewListener);
    process.off("removeListener", onRemoveListener);
    process.off("warning", onWarning);
    process.off("message", onMessage);
    process.send(
      {
        type: "openclaw-startup-exit-listeners:captured",
        exitListeners: {
          peak,
          current: process.listenerCount("exit"),
          defaultLimit,
          registrations,
          warnings,
        },
      },
      () => {},
    );
  };
  process.on("newListener", onNewListener);
  process.on("removeListener", onRemoveListener);
  process.on("warning", onWarning);
  process.on("message", onMessage);
  process.channel?.unref();
}
