import type { CliBackendTurnInterrupt } from "../../plugins/cli-backend.types.js";

type CliTurnInterruptReason = Parameters<CliBackendTurnInterrupt["interrupt"]>[0];

/** Sends one graceful turn end once both its reason and the backend capability are known. */
export function createCliTurnInterruptRequest() {
  let interrupt: CliBackendTurnInterrupt | undefined;
  let supported = false;
  let reason: CliTurnInterruptReason | undefined;
  let pending: Promise<void> | undefined;
  const flush = () => {
    if (!reason || !interrupt || pending) {
      return;
    }
    const target = interrupt;
    const requested = reason;
    pending = Promise.resolve().then(() => target.interrupt(requested));
    // The execution owner joins this promise and cancels the transport on failure.
    void pending.catch(() => {});
  };
  return {
    register(next: CliBackendTurnInterrupt | undefined) {
      interrupt = next;
      supported ||= next !== undefined;
      flush();
    },
    request(next: CliTurnInterruptReason) {
      reason ??= next;
      flush();
    },
    isSupported: () => supported,
    reason: () => reason,
    wait: () => pending,
  };
}
