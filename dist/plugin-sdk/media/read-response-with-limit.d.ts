export declare function readResponseWithLimit(res: Response, maxBytes: number, opts?: {
    onOverflow?: (params: {
        size: number;
        maxBytes: number;
        res: Response;
    }) => Error;
}): Promise<Buffer>;
