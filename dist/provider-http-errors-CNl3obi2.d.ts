//#region src/shared/number-coercion.d.ts
declare function asFiniteNumber(value: unknown): number | undefined;
//#endregion
//#region src/agents/provider-http-errors.d.ts
declare function asBoolean(value: unknown): boolean | undefined;
declare function asObject(value: unknown): Record<string, unknown> | undefined;
declare function truncateErrorDetail(detail: string, limit?: number): string;
declare function readResponseTextLimited(response: Response, limitBytes?: number): Promise<string>;
declare function formatProviderErrorPayload(payload: unknown): string | undefined;
declare function extractProviderErrorDetail(response: Response): Promise<string | undefined>;
declare function extractProviderRequestId(response: Response): string | undefined;
declare function formatProviderHttpErrorMessage(params: {
  label: string;
  status: number;
  detail?: string;
  requestId?: string;
  statusPrefix?: string;
}): string;
declare function createProviderHttpError(response: Response, label: string, options?: {
  statusPrefix?: string;
}): Promise<Error>;
declare function assertOkOrThrowProviderError(response: Response, label: string): Promise<void>;
declare function assertOkOrThrowHttpError(response: Response, label: string): Promise<void>;
declare function readProviderJsonResponse<T>(response: Response, label: string): Promise<T>;
declare function readProviderJsonObjectResponse(response: Response, label: string): Promise<Record<string, unknown>>;
declare function readProviderJsonArrayFieldResponse(response: Response, label: string, field: string): Promise<unknown[]>;
declare function assertProviderBinaryResponseContent(response: Response, label: string, kind?: string): void;
declare function readProviderBinaryResponse(response: Response, label: string, kind?: string): Promise<Uint8Array>;
//#endregion
export { asFiniteNumber as _, assertProviderBinaryResponseContent as a, extractProviderRequestId as c, readProviderBinaryResponse as d, readProviderJsonArrayFieldResponse as f, truncateErrorDetail as g, readResponseTextLimited as h, assertOkOrThrowProviderError as i, formatProviderErrorPayload as l, readProviderJsonResponse as m, asObject as n, createProviderHttpError as o, readProviderJsonObjectResponse as p, assertOkOrThrowHttpError as r, extractProviderErrorDetail as s, asBoolean as t, formatProviderHttpErrorMessage as u };