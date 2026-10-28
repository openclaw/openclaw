/** Test-only seams for host ingress/runner boundary regressions. */
export { openXAllowlist } from "./src/allowlist.js";
export { createXPublicationPreparation, resolveXIngress } from "./src/ingress.js";
export { setXRuntime } from "./src/runtime.js";
export { createKeyedState } from "./src/test-support/monitor.js";
