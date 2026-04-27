export { asFiniteNumber } from "../shared/number-coercion.js";
export { normalizeOptionalString as trimToUndefined } from "../shared/string-coerce.js";
export declare function asBoolean(value: unknown): boolean | undefined;
export declare function asObject(value: unknown): Record<string, unknown> | undefined;
export declare function truncateErrorDetail(detail: string, limit?: number): string;
export declare function readResponseTextLimited(response: Response, limitBytes?: number): Promise<string>;
export declare function formatProviderErrorPayload(payload: unknown): string | undefined;
export declare function extractProviderErrorDetail(response: Response): Promise<string | undefined>;
export declare function extractProviderRequestId(response: Response): string | undefined;
export declare function formatProviderHttpErrorMessage(params: {
    label: string;
    status: number;
    detail?: string;
    requestId?: string;
    statusPrefix?: string;
}): string;
export declare function createProviderHttpError(response: Response, label: string, options?: {
    statusPrefix?: string;
}): Promise<Error>;
export declare function assertOkOrThrowProviderError(response: Response, label: string): Promise<void>;
export declare function assertOkOrThrowHttpError(response: Response, label: string): Promise<void>;
