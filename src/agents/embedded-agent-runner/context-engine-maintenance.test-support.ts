import "./context-engine-maintenance.js";

type ContextEngineMaintenanceTestApi = {
  resetDeferredTurnMaintenanceStateForTest(): void;
};

function getTestApi(): ContextEngineMaintenanceTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.contextEngineMaintenanceTestApi")
  ] as ContextEngineMaintenanceTestApi;
}

export function resetDeferredTurnMaintenanceStateForTest(): void {
  getTestApi().resetDeferredTurnMaintenanceStateForTest();
}
