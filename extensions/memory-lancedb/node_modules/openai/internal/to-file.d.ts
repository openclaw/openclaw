import type { FilePropertyBag } from "./builtin-types.js";
type BlobLikePart = string | ArrayBuffer | ArrayBufferView | BlobLike | DataView;
/**
 * Intended to match DOM Blob, node-fetch Blob, node:buffer Blob, etc.
 * Don't add arrayBuffer here, node-fetch doesn't have it
 */
interface BlobLike {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Blob/size) */
    readonly size: number;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Blob/type) */
    readonly type: string;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Blob/text) */
    text(): Promise<string>;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/Blob/slice) */
    slice(start?: number, end?: number): BlobLike;
}
/**
 * Intended to match DOM File, node:buffer File, undici File, etc.
 */
interface FileLike extends BlobLike {
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/File/lastModified) */
    readonly lastModified: number;
    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/File/name) */
    readonly name?: string | undefined;
}
/**
 * Intended to match DOM Response, node-fetch Response, undici Response, etc.
 */
export interface ResponseLike {
    url: string;
    blob(): Promise<BlobLike>;
}
export type ToFileInput = FileLike | ResponseLike | Exclude<BlobLikePart, string> | AsyncIterable<BlobLikePart>;
/**
 * Helper for creating a {@link File} to pass to an SDK upload method from a variety of different data formats
 * @param value the raw content of the file. Can be an {@link Uploadable}, BlobLikePart, or AsyncIterable of BlobLikeParts
 * @param {string=} name the name of the file. If omitted, toFile will try to determine a file name from bits if possible
 * @param {Object=} options additional properties
 * @param {string=} options.type the MIME type of the content
 * @param {number=} options.lastModified the last modified timestamp
 * @returns a {@link File} with the given properties
 */
export declare function toFile(value: ToFileInput | PromiseLike<ToFileInput>, name?: string | null | undefined, options?: FilePropertyBag | undefined): Promise<File>;
export {};
//# sourceMappingURL=to-file.d.ts.map