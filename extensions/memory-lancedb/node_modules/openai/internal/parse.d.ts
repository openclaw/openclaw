import type { FinalRequestOptions } from "./request-options.js";
import { type OpenAI } from "../client.js";
import type { AbstractPage } from "../pagination.js";
export type APIResponseProps = {
    response: Response;
    options: FinalRequestOptions;
    controller: AbortController;
    requestLogID: string;
    retryOfRequestLogID: string | undefined;
    startTime: number;
};
export declare function defaultParseResponse<T>(client: OpenAI, props: APIResponseProps): Promise<WithRequestID<T>>;
export type WithRequestID<T> = T extends Array<any> | Response | AbstractPage<any> ? T : T extends Record<string, any> ? T & {
    _request_id?: string | null;
} : T;
export declare function addRequestID<T>(value: T, response: Response): WithRequestID<T>;
//# sourceMappingURL=parse.d.ts.map