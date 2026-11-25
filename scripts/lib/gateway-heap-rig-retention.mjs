import { randomUUID } from "node:crypto";

/** Private IPC to the synthetic Gateway; never attaches to an operator process. */
export async function captureHeapRigRetention(child, action, mode, snapshotPath) {
  const id = randomUUID();
  const reply = Promise.withResolvers();
  const listener = (message) => {
    if (message?.channel !== "heap-rig-retention" || message.id !== id) {
      return;
    }
    if (message.error) {
      reply.reject(new Error(message.error));
    } else {
      reply.resolve(message.observation);
    }
  };
  child.on("message", listener);
  const timeout = setTimeout(
    () => reply.reject(new Error("Retention checkpoint timed out")),
    snapshotPath ? 300_000 : 120_000,
  );
  try {
    child.send({ channel: "heap-rig-retention", id, action, mode, snapshotPath });
    return await reply.promise;
  } finally {
    clearTimeout(timeout);
    child.off("message", listener);
  }
}
