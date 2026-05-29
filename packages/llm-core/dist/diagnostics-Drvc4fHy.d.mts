//#region packages/llm-core/src/utils/diagnostics.d.ts
interface DiagnosticErrorInfo {
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
}
interface AssistantMessageDiagnostic {
  type: string;
  timestamp: number;
  error?: DiagnosticErrorInfo;
  details?: Record<string, unknown>;
}
declare function formatThrownValue(value: unknown): string;
declare function extractDiagnosticError(error: unknown): DiagnosticErrorInfo;
declare function createAssistantMessageDiagnostic(type: string, error: unknown, details?: Record<string, unknown>): AssistantMessageDiagnostic;
declare function appendAssistantMessageDiagnostic(message: {
  diagnostics?: AssistantMessageDiagnostic[];
}, diagnostic: AssistantMessageDiagnostic): void;
//#endregion
export { extractDiagnosticError as a, createAssistantMessageDiagnostic as i, DiagnosticErrorInfo as n, formatThrownValue as o, appendAssistantMessageDiagnostic as r, AssistantMessageDiagnostic as t };