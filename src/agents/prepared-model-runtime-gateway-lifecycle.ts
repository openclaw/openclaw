/** Gateway lifecycles own configured-agent inventory; standalone hosts stay workspace-scoped. */
let gatewayLifecycleActive = false;

export function isPreparedModelRuntimeGatewayLifecycleActive(): boolean {
  return gatewayLifecycleActive;
}

export function setPreparedModelRuntimeGatewayLifecycleActive(active: boolean): void {
  gatewayLifecycleActive = active;
}
