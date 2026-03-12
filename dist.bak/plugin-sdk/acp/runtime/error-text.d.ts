import { type AcpRuntimeErrorCode, AcpRuntimeError } from "./errors.js";
export declare function formatAcpRuntimeErrorText(error: AcpRuntimeError): string;
export declare function toAcpRuntimeErrorText(params: {
    error: unknown;
    fallbackCode: AcpRuntimeErrorCode;
    fallbackMessage: string;
}): string;
