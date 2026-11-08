/** Binary messages are small even when an admitted attachment exceeds an inline RPC. */
export const FILE_CREATE_CHUNK_BYTES = 1024 * 1024;
const FILE_CREATE_DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export function readFileCreateMetadata(params: Record<string, unknown>, policyMaxBytes?: number) {
  const sizeBytes = params.sizeBytes;
  const requestedMax = params.maxBytes ?? FILE_CREATE_DEFAULT_MAX_BYTES;
  const expectedSha256 = params.expectedSha256;
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error("file.create sizeBytes must be a non-negative safe integer");
  }
  if (typeof requestedMax !== "number" || !Number.isSafeInteger(requestedMax) || requestedMax < 0) {
    throw new Error("file.create maxBytes must be a non-negative safe integer");
  }
  const maxBytes =
    policyMaxBytes === undefined ? requestedMax : Math.min(requestedMax, policyMaxBytes);
  if (sizeBytes > maxBytes) {
    throw new Error("file.create sizeBytes exceeds the authorized byte limit");
  }
  if (typeof expectedSha256 !== "string" || !/^[a-fA-F0-9]{64}$/u.test(expectedSha256)) {
    throw new Error("file.create expectedSha256 must be a SHA-256 digest");
  }
  return { sizeBytes, maxBytes, expectedSha256: expectedSha256.toLowerCase() };
}
