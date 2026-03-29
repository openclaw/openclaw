/**
 * Most browsers don't yet have async iterable support for ReadableStream,
 * and Node has a very different way of reading bytes from its "ReadableStream".
 *
 * This polyfill was pulled from https://github.com/MattiasBuelens/web-streams-polyfill/pull/122#issuecomment-1627354490
 */
export declare function ReadableStreamToAsyncIterable<T>(stream: any): AsyncIterableIterator<T>;
//# sourceMappingURL=stream-utils.d.ts.map