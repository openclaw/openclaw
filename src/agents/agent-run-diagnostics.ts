/**
 * Tracks diagnostic information (lastTool, completedSteps) for agent runs.
 * Used to include context in error events when they're emitted.
 */

export type AgentRunDiagnostics = {
  lastTool?: string;
  completedSteps: number;
  partialProgress?: string;
};

const runDiagnostics = new Map<string, AgentRunDiagnostics>();

/** Get or create diagnostics for a run */
function ensureDiagnostics(runId: string): AgentRunDiagnostics {
  let diag = runDiagnostics.get(runId);
  if (!diag) {
    diag = { completedSteps: 0 };
    runDiagnostics.set(runId, diag);
  }
  return diag;
}

/** Called when a tool starts executing */
export function trackToolStart(runId: string, toolName: string): void {
  const diag = ensureDiagnostics(runId);
  diag.lastTool = toolName;
}

/** Called when a tool completes successfully */
export function trackToolSuccess(runId: string): void {
  const diag = ensureDiagnostics(runId);
  diag.completedSteps++;
}

/** Called when a tool fails - stores error as partial progress */
export function trackToolError(runId: string, error?: string): void {
  const diag = ensureDiagnostics(runId);
  if (error) {
    diag.partialProgress = error;
  }
}

/** Get current diagnostics for a run (for including in error events) */
export function getRunDiagnostics(runId: string): AgentRunDiagnostics | undefined {
  return runDiagnostics.get(runId);
}

/** Clear diagnostics when run completes (success or error) */
export function clearRunDiagnostics(runId: string): void {
  runDiagnostics.delete(runId);
}

/** Get diagnostics as plain object for event data */
export function getDiagnosticsForEvent(runId: string): {
  lastTool?: string;
  completedSteps?: number;
  partialProgress?: string;
} {
  const diag = runDiagnostics.get(runId);
  if (!diag) {
    return {};
  }
  return {
    lastTool: diag.lastTool,
    completedSteps: diag.completedSteps > 0 ? diag.completedSteps : undefined,
    partialProgress: diag.partialProgress,
  };
}
