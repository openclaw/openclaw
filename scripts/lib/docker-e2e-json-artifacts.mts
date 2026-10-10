import { readBoundedArtifactText } from "./bounded-artifact-text.mts";
import { parsePositiveInt } from "./numeric-options.mjs";

const JSON_ARTIFACT_MAX_BYTES_ENV = "OPENCLAW_DOCKER_E2E_JSON_ARTIFACT_MAX_BYTES";
const DEFAULT_JSON_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;

export function readDockerE2eJsonArtifact(file: string): unknown {
  const maxBytes = parsePositiveInt(
    process.env[JSON_ARTIFACT_MAX_BYTES_ENV] || String(DEFAULT_JSON_ARTIFACT_MAX_BYTES),
    JSON_ARTIFACT_MAX_BYTES_ENV,
  );
  return JSON.parse(readBoundedArtifactText(file, maxBytes, "JSON artifact"));
}
