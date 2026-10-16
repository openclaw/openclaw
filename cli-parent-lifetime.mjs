import { GATEWAY_SHUTDOWN_RESERVE_MS } from "./gateway-shutdown-budget.mjs";

const parentKey = Symbol.for("openclaw.cliRespawnParent");
// Consume the private preload so later detached workers cannot inherit this contract.
export const CLI_PARENT_BOUND_PRELOAD = `data:text/javascript,${encodeURIComponent(`
  globalThis[Symbol.for("openclaw.cliRespawnParent")] = { pid: process.ppid };
  process.execArgv = process.execArgv.filter((arg, index, args) =>
    arg !== import.meta.url && !(arg === "--import" && args[index + 1] === import.meta.url));
`)}`;

/** Only the respawn producer opts in; detached update drivers keep independent custody. */
export function getCliParentPid() {
  return globalThis[parentKey]?.pid;
}

let terminating = false;
export function requestCliParentTermination(
  signal = () => {
    if (!process.emit("SIGTERM")) {
      process.kill(process.pid, "SIGTERM");
    }
  },
) {
  if (terminating) {
    return;
  }
  terminating = true;
  // Doctor's signal gate cancels work and settles rollback/restoration before exit.
  setTimeout(() => process.kill(process.pid, "SIGKILL"), GATEWAY_SHUTDOWN_RESERVE_MS).unref();
  signal();
}

export function watchCliRespawnParent() {
  const parent = globalThis[parentKey];
  if (!parent || parent.watching || !process.channel) {
    return;
  }
  parent.watching = true;
  process.once("disconnect", requestCliParentTermination);
  process.channel.unref();
  if (!process.connected) {
    requestCliParentTermination();
  }
}
