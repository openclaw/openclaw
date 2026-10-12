import { retainCurrentWorkerNativeSection } from "@openclaw/worker-runtime/worker";

/** Keep the refresh owner alive until its durable claim settles or rolls back. */
export function beginOAuthRefreshObservation() {
  return { finish: retainCurrentWorkerNativeSection() };
}
