import type { ServerResponse } from "node:http";
export declare function createMockServerResponse(): ServerResponse & {
    body?: string;
};
