import { BlobPart, getName, makeFile, isAsyncIterable } from './uploads';
import type { FilePropertyBag } from './builtin-types';
import { checkFileSupport } from './uploads';

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
 * This check adds the arrayBuffer() method type because it is available and used at runtime
 */
const isBlobLike = (value: any): value is BlobLike & { arrayBuffer(): Promise<ArrayBuffer> } =>
  value != null &&
  typeof value === 'object' &&
  typeof value.size === 'number' &&
  typeof value.type === 'string' &&
  typeof value.text === 'function' &&
  typeof value.slice === 'function' &&
  typeof value.arrayBuffer === 'function';

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
 * This check adds the arrayBuffer() method type because it is available and used at runtime
 */
const isFileLike = (value: any): value is FileLike & { arrayBuffer(): Promise<ArrayBuffer> } =>
  value != null &&
  typeof value === 'object' &&
  typeof value.name === 'string' &&
  typeof value.lastModified === 'number' &&
  isBlobLike(value);

/**
 * Intended to match DOM Response, node-fetch Response, undici Response, etc.
 */
export interface ResponseLike {
  url: string;
  blob(): Promise<BlobLike>;
}

const isResponseLike = (value: any): value is ResponseLike =>
  value != null &&
  typeof value === 'object' &&
  typeof value.url === 'string' &&
  typeof value.blob === 'function';

export type ToFileInput =
  | FileLike
  | ResponseLike
  | Exclude<BlobLikePart, string>
  | AsyncIterable<BlobLikePart>;

/**
 * Helper for creating a {@link File} to pass to an SDK upload method from a variety of different data formats
 * @param value the raw content of the file. Can be an {@link Uploadable}, BlobLikePart, or AsyncIterable of BlobLikeParts
 * @param {string=} name the name of the file. If omitted, toFile will try to determine a file name from bits if possible
 * @param {Object=} options additional properties
 * @param {string=} options.type the MIME type of the content
 * @param {number=} options.lastModified the last modified timestamp
 * @returns a {@link File} with the given properties
 */
export async function toFile(
  value: ToFileInput | PromiseLike<ToFileInput>,
  name?: string | null | undefined,
  options?: FilePropertyBag | undefined,
): Promise<File> {
  checkFileSupport();

  // If it's a promise, resolve it.
  value = await value;

  // If we've been given a `File` we don't need to do anything
  if (isFileLike(value)) {
    if (value instanceof File) {
      return value;
    }
    return makeFile([await value.arrayBuffer()], value.name);
  }

  if (isResponseLike(value)) {
    const blob = await value.blob();
    name ||= new URL(value.url).pathname.split(/[\\/]/).pop();

    return makeFile(await getBytes(blob), name, options);
  }

  const parts = await getBytes(value);

  name ||= getName(value);

  if (!options?.type) {
    const type = parts.find((part) => typeof part === 'object' && 'type' in part && part.type);
    if (typeof type === 'string') {
      options = { ...options, type };
    }
  }

  return makeFile(parts, name, options);
}

async function getBytes(value: BlobLikePart | AsyncIterable<BlobLikePart>): Promise<Array<BlobPart>> {
  let parts: Array<BlobPart> = [];
  if (
    typeof value === 'string' ||
    ArrayBuffer.isView(value) || // includes Uint8Array, Buffer, etc.
    value instanceof ArrayBuffer
  ) {
    parts.push(value);
  } else if (isBlobLike(value)) {
    parts.push(value instanceof Blob ? value : await value.arrayBuffer());
  } else if (
    isAsyncIterable(value) // includes Readable, ReadableStream, etc.
  ) {
    for await (const chunk of value) {
      parts.push(...(await getBytes(chunk as BlobLikePart))); // TODO, consider validating?
    }
  } else {
    const constructor = value?.constructor?.name;
    throw new Error(
      `Unexpected data type: ${typeof value}${
        constructor ? `; constructor: ${constructor}` : ''
      }${propsForError(value)}`,
    );
  }

  return parts;
}

function propsForError(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const props = Object.getOwnPropertyNames(value);
  return `; props: [${props.map((p) => `"${p}"`).join(', ')}]`;
}
