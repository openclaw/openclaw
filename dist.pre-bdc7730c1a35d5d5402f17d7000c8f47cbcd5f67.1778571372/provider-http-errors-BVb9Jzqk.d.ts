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
//#endregion
export { createProviderHttpError as a, formatProviderErrorPayload as c, truncateErrorDetail as d, asFiniteNumber as f, assertOkOrThrowProviderError as i, formatProviderHttpErrorMessage as l, asObject as n, extractProviderErrorDetail as o, assertOkOrThrowHttpError as r, extractProviderRequestId as s, asBoolean as t, readResponseTextLimited as u };