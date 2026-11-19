import { createReleaseEvidenceClient } from "../release-ci-summary.mjs";
import { isRecord } from "./record-shared.mjs";
import {
  parseReleaseValidationWaivers,
  RELEASE_VALIDATION_WAIVERS_PATH,
} from "./release-validation-waivers.mjs";

// Publication admission authenticates the manifest and its exact Q before side
// effects. Downstream policy consumers must read that Q, not their executing P.
export function readReleaseManifestWaivers(
  manifest: unknown,
  readSource?: (sha: string, path: string) => string,
) {
  if (
    !isRecord(manifest) ||
    !isRecord(manifest.sourceAdmission) ||
    !manifest.sourceAdmission.qualificationAdmission
  ) {
    return undefined;
  }
  if (typeof manifest.workflowSha !== "string" || !/^[a-f0-9]{40}$/u.test(manifest.workflowSha)) {
    throw new Error("Release manifest is missing its exact qualification Q");
  }
  return parseReleaseValidationWaivers(
    readSource
      ? readSource(manifest.workflowSha, RELEASE_VALIDATION_WAIVERS_PATH)
      : createReleaseEvidenceClient("openclaw/openclaw").getWorkflowSource(
          manifest.workflowSha,
          RELEASE_VALIDATION_WAIVERS_PATH,
        ),
  );
}
