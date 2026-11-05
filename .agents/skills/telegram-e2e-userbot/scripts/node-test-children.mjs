import { spawn } from "node:child_process";

// Child processes owned by one node:test case. Register stopChildren and the temp-root
// cleanup in a single after hook, children first: node:test runs after hooks in
// registration order and skips the rest once one throws.

// Completion is the child closing its pipes; only the test timeout bounds a stalled
// host. The test's after hook kills and joins whatever a timed-out body left running.
export function run(context, children, command, args, options) {
  context.signal.throwIfAborted();
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve) => {
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  children.add({ child, closed });
  return new Promise((resolve, reject) => {
    const abort = () => {
      const error = new Error(
        `Child did not finish before the test ended:\n${stderr.slice(-4000)}`,
        {
          cause: context.signal.reason,
        },
      );
      context.diagnostic(error.message);
      reject(error);
    };
    context.signal.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    closed.then(resolve).finally(() => context.signal.removeEventListener("abort", abort));
  });
}

// A descendant can hold the pipes after its parent exits, so always kill the group.
export async function stopChildren(children) {
  for (const { child } of children) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH" && error.code !== "EPERM") {
          throw error;
        }
      }
    }
  }
  await Promise.all([...children].map(({ closed }) => closed));
}
