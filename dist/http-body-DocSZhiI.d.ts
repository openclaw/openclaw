import { IncomingMessage, ServerResponse } from "node:http";

//#region src/infra/http-body.d.ts
declare const DEFAULT_WEBHOOK_MAX_BODY_BYTES: number;
declare const DEFAULT_WEBHOOK_BODY_TIMEOUT_MS = 30000;
type RequestBodyLimitErrorCode = "PAYLOAD_TOO_LARGE" | "REQUEST_BODY_TIMEOUT" | "CONNECTION_CLOSED";
type RequestBodyLimitErrorInit = {
  code: RequestBodyLimitErrorCode;
  message?: string;
};
declare class RequestBodyLimitError extends Error {
  readonly code: RequestBodyLimitErrorCode;
  readonly statusCode: number;
  constructor(init: RequestBodyLimitErrorInit);
}
declare function isRequestBodyLimitError(error: unknown, code?: RequestBodyLimitErrorCode): error is RequestBodyLimitError;
declare function requestBodyErrorToText(code: RequestBodyLimitErrorCode): string;
type ReadRequestBodyOptions = {
  maxBytes: number;
  timeoutMs?: number;
  encoding?: BufferEncoding;
};
declare function readRequestBodyWithLimit(req: IncomingMessage, options: ReadRequestBodyOptions): Promise<string>;
type ReadJsonBodyResult = {
  ok: true;
  value: unknown;
} | {
  ok: false;
  error: string;
  code: RequestBodyLimitErrorCode | "INVALID_JSON";
};
type ReadJsonBodyOptions = ReadRequestBodyOptions & {
  emptyObjectOnEmpty?: boolean;
};
declare function readJsonBodyWithLimit(req: IncomingMessage, options: ReadJsonBodyOptions): Promise<ReadJsonBodyResult>;
type RequestBodyLimitGuard = {
  dispose: () => void;
  isTripped: () => boolean;
  code: () => RequestBodyLimitErrorCode | null;
};
type RequestBodyLimitGuardOptions = {
  maxBytes: number;
  timeoutMs?: number;
  responseFormat?: "json" | "text";
  responseText?: Partial<Record<RequestBodyLimitErrorCode, string>>;
};
declare function installRequestBodyLimitGuard(req: IncomingMessage, res: ServerResponse, options: RequestBodyLimitGuardOptions): RequestBodyLimitGuard;
//#endregion
export { ReadRequestBodyOptions as a, RequestBodyLimitGuard as c, isRequestBodyLimitError as d, readJsonBodyWithLimit as f, ReadJsonBodyResult as i, RequestBodyLimitGuardOptions as l, requestBodyErrorToText as m, DEFAULT_WEBHOOK_MAX_BODY_BYTES as n, RequestBodyLimitError as o, readRequestBodyWithLimit as p, ReadJsonBodyOptions as r, RequestBodyLimitErrorCode as s, DEFAULT_WEBHOOK_BODY_TIMEOUT_MS as t, installRequestBodyLimitGuard as u };