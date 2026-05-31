import { AcpRuntimeError, AcpRuntimeErrorCode } from "./errors.mjs";

//#region src/runtime/error-text.d.ts
declare function formatAcpRuntimeErrorText(error: AcpRuntimeError): string;
declare function toAcpRuntimeErrorText(params: {
  error: unknown;
  fallbackCode: AcpRuntimeErrorCode;
  fallbackMessage: string;
}): string;
//#endregion
export { formatAcpRuntimeErrorText, toAcpRuntimeErrorText };