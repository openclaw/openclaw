import type { GatewayControlUiIngressV1 } from "openclaw/plugin-sdk/gateway-ingress";
import { UiTunnelError } from "./ui-tunnel-protocol.js";

type Waiter = {
  resolve: (handle: GatewayControlUiIngressV1) => void;
  reject: (error: unknown) => void;
};
export type UiIngressAdmission = {
  opened?: GatewayControlUiIngressV1;
  waiters: Set<Waiter>;
};

export function waitForUiIngress(
  admission: UiIngressAdmission,
  signal: AbortSignal,
): Promise<GatewayControlUiIngressV1> {
  const closed = () => new UiTunnelError("unavailable", "The Control UI stream has closed.");
  if (signal.aborted) {
    return Promise.reject(closed());
  }
  if (admission.opened) {
    return Promise.resolve(admission.opened);
  }
  // One factory completion owns the waiters; cancelled streams leave no promise continuations behind.
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      admission.waiters.delete(waiter);
      signal.removeEventListener("abort", onAbort);
    };
    const waiter: Waiter = {
      resolve: (handle) => {
        cleanup();
        resolve(handle);
      },
      reject: (error) => {
        cleanup();
        reject(
          error instanceof Error ? error : new Error("Control UI ingress failed", { cause: error }),
        );
      },
    };
    const onAbort = () => waiter.reject(closed());
    admission.waiters.add(waiter);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
