import type { PendingCodexDiagnosticsConfirmation } from "./command-handlers.js";

/** Runtime state for diagnostics upload throttling and confirmation handshakes. */
export const codexDiagnosticsFeedbackState = {
  lastUploadByThread: new Map<string, number>(),
  lastUploadByScope: new Map<string, number>(),
  pendingConfirmations: new Map<string, PendingCodexDiagnosticsConfirmation>(),
  pendingTokensByScope: new Map<string, string[]>(),
  clear(): void {
    this.lastUploadByThread.clear();
    this.lastUploadByScope.clear();
    this.pendingConfirmations.clear();
    this.pendingTokensByScope.clear();
  },
};
