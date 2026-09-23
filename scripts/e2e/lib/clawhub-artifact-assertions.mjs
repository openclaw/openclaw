export function assertClawHubArtifactMetadata(record, messagePrefixes) {
  if (record.artifactKind === "legacy-zip") {
    if (record.artifactFormat !== "zip") {
      throw new Error(`${messagePrefixes.legacyZip}: ${JSON.stringify(record)}`);
    }
    return;
  }

  if (record.artifactKind !== "npm-pack" || record.artifactFormat !== "tgz") {
    throw new Error(`${messagePrefixes.artifact}: ${JSON.stringify(record)}`);
  }
  if (!record.clawpackSha256 || typeof record.clawpackSize !== "number") {
    throw new Error(`${messagePrefixes.clawpack}: ${JSON.stringify(record)}`);
  }
  if (!record.npmIntegrity || !record.npmShasum || !record.npmTarballName) {
    throw new Error(`${messagePrefixes.npm}: ${JSON.stringify(record)}`);
  }
}
