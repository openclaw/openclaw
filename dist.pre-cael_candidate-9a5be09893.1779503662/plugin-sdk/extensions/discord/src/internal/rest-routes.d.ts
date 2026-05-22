type QueryValue = string | number | boolean;
export declare function createRouteKey(method: string, path: string): string;
export declare function createBucketKey(bucket: string, path: string): string;
export declare function readHeaderNumber(headers: Headers, name: string): number | undefined;
export declare function readResetAt(response: Response): number | undefined;
export declare function appendQuery(path: string, query?: Record<string, QueryValue>): string;
export {};
