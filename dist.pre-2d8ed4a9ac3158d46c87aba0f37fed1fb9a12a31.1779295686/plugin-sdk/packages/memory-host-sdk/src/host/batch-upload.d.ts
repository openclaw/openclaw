import { type BatchHttpClientConfig } from "./batch-utils.js";
export declare function uploadBatchJsonlFile(params: {
    client: BatchHttpClientConfig;
    requests: unknown[];
    errorPrefix: string;
}): Promise<string>;
