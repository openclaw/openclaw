//#region src/media/read-byte-stream-with-limit.d.ts
type ByteStreamLimitOverflow = {
  size: number;
  maxBytes: number;
};
type ReadByteStreamWithLimitOptions = {
  maxBytes: number;
  onOverflow?: (params: ByteStreamLimitOverflow) => Error;
};
declare function readByteStreamWithLimit(stream: AsyncIterable<unknown>, opts: ReadByteStreamWithLimitOptions): Promise<Buffer>;
//#endregion
//#region src/media/read-response-with-limit.d.ts
declare function readResponseWithLimit(res: Response, maxBytes: number, opts?: {
  onOverflow?: (params: {
    size: number;
    maxBytes: number;
    res: Response;
  }) => Error;
  chunkTimeoutMs?: number;
  onIdleTimeout?: (params: {
    chunkTimeoutMs: number;
  }) => Error;
}): Promise<Buffer>;
declare function readResponseTextSnippet(res: Response, opts?: {
  maxBytes?: number;
  maxChars?: number;
  chunkTimeoutMs?: number;
  onIdleTimeout?: (params: {
    chunkTimeoutMs: number;
  }) => Error;
}): Promise<string | undefined>;
//#endregion
export { readByteStreamWithLimit as a, ReadByteStreamWithLimitOptions as i, readResponseWithLimit as n, ByteStreamLimitOverflow as r, readResponseTextSnippet as t };