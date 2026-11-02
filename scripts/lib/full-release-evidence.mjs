// Parent and child receipts share one wire budget across producers and readers.
export const MAX_RELEASE_ARTIFACT_BYTES = 1024 * 1024;
export const FULL_RELEASE_CHILD_EVIDENCE_JOB =
  "Seal full release child evidence / Seal child receipt";

export function serializeReleaseArtifact(payload) {
  const json = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(json, "utf8") > MAX_RELEASE_ARTIFACT_BYTES) {
    throw new Error("release artifact exceeds the size limit");
  }
  return json;
}
