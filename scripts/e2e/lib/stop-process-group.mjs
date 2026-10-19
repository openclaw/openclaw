import { once } from "node:events";

export async function stopProcessGroup(child, { graceMs, ignoreSignalErrors = false }) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      // Strict callers retain TERM errors and tolerate only a group gone by SIGKILL.
      if (!ignoreSignalErrors && (name !== "SIGKILL" || error.code !== "ESRCH")) {
        throw error;
      }
    }
  };
  signal("SIGTERM");
  const killTimer = setTimeout(() => signal("SIGKILL"), graceMs);
  try {
    await exited;
  } finally {
    clearTimeout(killTimer);
  }
}
