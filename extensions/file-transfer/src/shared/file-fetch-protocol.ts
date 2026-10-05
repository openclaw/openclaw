export const FILE_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
export const FILE_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
export const FILE_FETCH_CHUNK_BYTES = 1024 * 1024;

/** Binary fetches require an explicit total budget; unary limits stay unchanged. */
export function readFileFetchBinaryMaxBytes(params: {
  transport?: unknown;
  maxBytes?: unknown;
}): number | undefined {
  if (params.transport === undefined) {
    return undefined;
  }
  if (params.transport !== "binary") {
    throw new Error('file.fetch transport must be "binary" when supplied');
  }
  if (
    typeof params.maxBytes !== "number" ||
    !Number.isSafeInteger(params.maxBytes) ||
    params.maxBytes <= 0
  ) {
    throw new Error("binary file.fetch maxBytes must be a positive safe integer");
  }
  return params.maxBytes;
}
