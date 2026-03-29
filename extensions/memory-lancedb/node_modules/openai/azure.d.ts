import type { RequestInit } from "./internal/builtin-types.js";
import type { NullableHeaders } from "./internal/headers.js";
import { FinalRequestOptions } from "./internal/request-options.js";
import { ClientOptions, OpenAI } from "./client.js";
/** API Client for interfacing with the Azure OpenAI API. */
export interface AzureClientOptions extends ClientOptions {
    /**
     * Defaults to process.env['OPENAI_API_VERSION'].
     */
    apiVersion?: string | undefined;
    /**
     * Your Azure endpoint, including the resource, e.g. `https://example-resource.azure.openai.com/`
     */
    endpoint?: string | undefined;
    /**
     * A model deployment, if given, sets the base client URL to include `/deployments/{deployment}`.
     * Note: this means you won't be able to use non-deployment endpoints. Not supported with Assistants APIs.
     */
    deployment?: string | undefined;
    /**
     * Defaults to process.env['AZURE_OPENAI_API_KEY'].
     */
    apiKey?: string | undefined;
    /**
     * A function that returns an access token for Microsoft Entra (formerly known as Azure Active Directory),
     * which will be invoked on every request.
     */
    azureADTokenProvider?: (() => Promise<string>) | undefined;
}
/** API Client for interfacing with the Azure OpenAI API. */
export declare class AzureOpenAI extends OpenAI {
    deploymentName: string | undefined;
    apiVersion: string;
    /**
     * API Client for interfacing with the Azure OpenAI API.
     *
     * @param {string | undefined} [opts.apiVersion=process.env['OPENAI_API_VERSION'] ?? undefined]
     * @param {string | undefined} [opts.endpoint=process.env['AZURE_OPENAI_ENDPOINT'] ?? undefined] - Your Azure endpoint, including the resource, e.g. `https://example-resource.azure.openai.com/`
     * @param {string | undefined} [opts.apiKey=process.env['AZURE_OPENAI_API_KEY'] ?? undefined]
     * @param {string | undefined} opts.deployment - A model deployment, if given, sets the base client URL to include `/deployments/{deployment}`.
     * @param {string | null | undefined} [opts.organization=process.env['OPENAI_ORG_ID'] ?? null]
     * @param {string} [opts.baseURL=process.env['OPENAI_BASE_URL']] - Sets the base URL for the API, e.g. `https://example-resource.azure.openai.com/openai/`.
     * @param {number} [opts.timeout=10 minutes] - The maximum amount of time (in milliseconds) the client will wait for a response before timing out.
     * @param {number} [opts.httpAgent] - An HTTP agent used to manage HTTP(s) connections.
     * @param {Fetch} [opts.fetch] - Specify a custom `fetch` function implementation.
     * @param {number} [opts.maxRetries=2] - The maximum number of times the client will retry a request.
     * @param {Headers} opts.defaultHeaders - Default headers to include with every request to the API.
     * @param {DefaultQuery} opts.defaultQuery - Default query parameters to include with every request to the API.
     * @param {boolean} [opts.dangerouslyAllowBrowser=false] - By default, client-side use of this library is not allowed, as it risks exposing your secret API credentials to attackers.
     */
    constructor({ baseURL, apiKey, apiVersion, endpoint, deployment, azureADTokenProvider, dangerouslyAllowBrowser, ...opts }?: AzureClientOptions);
    buildRequest(options: FinalRequestOptions, props?: {
        retryCount?: number;
    }): Promise<{
        req: RequestInit & {
            headers: Headers;
        };
        url: string;
        timeout: number;
    }>;
    protected authHeaders(opts: FinalRequestOptions): Promise<NullableHeaders | undefined>;
}
//# sourceMappingURL=azure.d.ts.map