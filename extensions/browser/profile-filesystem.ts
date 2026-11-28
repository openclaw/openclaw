import {
  createPluginRuntimeProcessEntrypoint,
  resolveRuntimeWorkerUrl,
  WorkerTaskPool,
} from "openclaw/plugin-sdk/process-runtime";
import type {
  ProfileFilesystemCommand,
  ProfileFilesystemReply,
} from "./profile-filesystem.worker.js";

const workerUrl = resolveRuntimeWorkerUrl(
  createPluginRuntimeProcessEntrypoint("browserProfileFilesystem", import.meta.url),
);
// Locks stay borrowed while the host launches Chrome; preparation must have its own slots.
const locks = new WorkerTaskPool<ProfileFilesystemCommand, ProfileFilesystemReply>({ workerUrl });
const preparation = new WorkerTaskPool<ProfileFilesystemCommand, ProfileFilesystemReply>({
  workerUrl,
});

export async function withProfileFilesystemLock<T>(
  target: string,
  owner: string,
  run: () => Promise<T>,
): Promise<T> {
  let outcome: { value: T } | { error: unknown } | undefined;
  try {
    const reply = await locks.run(
      { type: "lock", target, owner },
      {
        onRequest: async () => {
          try {
            outcome = { value: await run() };
          } catch (error) {
            outcome = { error };
          }
          return { input: undefined, timeoutMs: 60_000 };
        },
      },
    );
    if (reply.failure) {
      const { error, ...properties } = reply.failure;
      throw Object.assign(error, properties);
    }
  } catch (error) {
    if (outcome && "error" in outcome) {
      throw new AggregateError(
        [outcome.error, error],
        "Browser operation and lock release failed",
        {
          cause: error,
        },
      );
    }
    throw error;
  }
  if (!outcome) {
    throw new Error("Browser lifecycle lock completed without running its operation");
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

export async function prepareProfileFilesystem(
  command: Exclude<ProfileFilesystemCommand, { type: "lock" }>,
): Promise<ProfileFilesystemReply> {
  const reply = await preparation.run(command, {});
  if (reply.failure) {
    const { error, ...properties } = reply.failure;
    throw Object.assign(error, properties);
  }
  return reply;
}
