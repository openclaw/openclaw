import { zt as AcpRuntime } from "./types.openclaw-BLF4DJTX.js";

//#region src/acp/runtime/errors.d.ts
declare const ACP_ERROR_CODES: readonly ["ACP_BACKEND_MISSING", "ACP_BACKEND_UNAVAILABLE", "ACP_BACKEND_UNSUPPORTED_CONTROL", "ACP_DISPATCH_DISABLED", "ACP_INVALID_RUNTIME_OPTION", "ACP_SESSION_INIT_FAILED", "ACP_TURN_FAILED"];
type AcpRuntimeErrorCode = (typeof ACP_ERROR_CODES)[number];
declare class AcpRuntimeError extends Error {
  readonly code: AcpRuntimeErrorCode;
  readonly cause?: unknown;
  constructor(code: AcpRuntimeErrorCode, message: string, options?: {
    cause?: unknown;
  });
}
declare function isAcpRuntimeError(value: unknown): value is AcpRuntimeError;
//#endregion
//#region src/acp/runtime/registry.d.ts
type AcpRuntimeBackend = {
  id: string;
  runtime: AcpRuntime;
  healthy?: () => boolean;
};
declare function registerAcpRuntimeBackend(backend: AcpRuntimeBackend): void;
declare function unregisterAcpRuntimeBackend(id: string): void;
declare function getAcpRuntimeBackend(id?: string): AcpRuntimeBackend | null;
declare function requireAcpRuntimeBackend(id?: string): AcpRuntimeBackend;
//#endregion
export { unregisterAcpRuntimeBackend as a, isAcpRuntimeError as c, requireAcpRuntimeBackend as i, getAcpRuntimeBackend as n, AcpRuntimeError as o, registerAcpRuntimeBackend as r, AcpRuntimeErrorCode as s, AcpRuntimeBackend as t };