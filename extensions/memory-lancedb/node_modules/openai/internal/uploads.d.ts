import { type RequestOptions } from "./request-options.js";
import type { FilePropertyBag, Fetch } from "./builtin-types.js";
import type { OpenAI } from "../client.js";
export type BlobPart = string | ArrayBuffer | ArrayBufferView | Blob | DataView;
type FsReadStream = AsyncIterable<Uint8Array> & {
    path: string | {
        toString(): string;
    };
};
interface BunFile extends Blob {
    readonly name?: string | undefined;
}
export declare const checkFileSupport: () => void;
/**
 * Typically, this is a native "File" class.
 *
 * We provide the {@link toFile} utility to convert a variety of objects
 * into the File class.
 *
 * For convenience, you can also pass a fetch Response, or in Node,
 * the result of fs.createReadStream().
 */
export type Uploadable = File | Response | FsReadStream | BunFile;
/**
 * Construct a `File` instance. This is used to ensure a helpful error is thrown
 * for environments that don't define a global `File` yet.
 */
export declare function makeFile(fileBits: BlobPart[], fileName: string | undefined, options?: FilePropertyBag): File;
export declare function getName(value: any): string | undefined;
export declare const isAsyncIterable: (value: any) => value is AsyncIterable<any>;
/**
 * Returns a multipart/form-data request if any part of the given request body contains a File / Blob value.
 * Otherwise returns the request as is.
 */
export declare const maybeMultipartFormRequestOptions: (opts: RequestOptions, fetch: OpenAI | Fetch) => Promise<RequestOptions>;
type MultipartFormRequestOptions = Omit<RequestOptions, 'body'> & {
    body: unknown;
};
export declare const multipartFormRequestOptions: (opts: MultipartFormRequestOptions, fetch: OpenAI | Fetch) => Promise<RequestOptions>;
export declare const createForm: <T = Record<string, unknown>>(body: T | undefined, fetch: OpenAI | Fetch) => Promise<FormData>;
export {};
//# sourceMappingURL=uploads.d.ts.map