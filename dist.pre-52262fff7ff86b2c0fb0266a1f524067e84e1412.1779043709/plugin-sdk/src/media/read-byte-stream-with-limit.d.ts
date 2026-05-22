export type ByteStreamLimitOverflow = {
    size: number;
    maxBytes: number;
};
export type ReadByteStreamWithLimitOptions = {
    maxBytes: number;
    onOverflow?: (params: ByteStreamLimitOverflow) => Error;
};
export declare function readByteStreamWithLimit(stream: AsyncIterable<unknown>, opts: ReadByteStreamWithLimitOptions): Promise<Buffer>;
