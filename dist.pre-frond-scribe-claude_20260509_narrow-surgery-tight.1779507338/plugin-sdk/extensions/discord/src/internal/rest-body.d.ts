type RequestData = {
    body?: unknown;
    multipartStyle?: "message" | "form";
    rawBody?: boolean;
    headers?: Record<string, string>;
};
export declare function serializeRequestBody(data: RequestData | undefined, headers: Headers): BodyInit | undefined;
export {};
