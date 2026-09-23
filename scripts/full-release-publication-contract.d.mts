export const FULL_RELEASE_SOURCE_ADMISSION_CONTRACT: "1";
export const FULL_RELEASE_PUBLICATION_ADMISSION_CONTRACT: "1";
export type ValidationPurpose =
  | "publish"
  | "diagnostic"
  | "main-qualification"
  | "postpublish-confidence";
export interface PublicationSelection {
  route: "normal" | "prepared" | "extended-stable" | "alpha";
  npmDistTag: "alpha" | "beta" | "latest" | "extended-stable";
  publishOpenclawNpm: boolean;
  pluginPublishScope: "selected" | "all-publishable";
  plugins: string[];
  windowsNodeTag?: string;
  windowsNodeInstallerDigests?: Record<string, string>;
}
export interface PublicationIntent {
  validationPurpose: ValidationPurpose;
  publicationSelection: PublicationSelection | null;
}
export interface PublicationDispatchEnvelope extends PublicationIntent {
  trustedWorkflow: { ref: string; fullRef: string; sha: string } | null;
}
export interface PublicationSourceRequest extends PublicationIntent {
  repository: string;
  candidateSha: string;
  targetContextRef: string;
  tooling: { ref: string; sha: string };
  workflow: { ref: string; sha: string };
  runId: string;
  runAttempt: number;
  coverage: Record<string, string>;
}
export interface PublicationSourceFact extends PublicationSourceRequest {
  kind: "openclaw.full-release-source-admission/v1";
  contract: "1";
  status: "source-admitted" | "not-applicable";
  inventoryDigest: string | null;
  projection: { version: string; packages: unknown[]; platforms: unknown[] } | null;
  digest: string;
}
export function publicationSourceContract(source: string): "1" | undefined;
export function publicationSourceJson(value: unknown): string;
export function normalizePublicationIntent(
  purpose: unknown,
  selectionJson?: unknown,
): PublicationIntent;
export function publicationIntentInputs(intent: PublicationIntent): {
  validationPurpose: ValidationPurpose;
  publicationSelectionJson: string;
};
export function decodePublicationDispatchEnvelope(raw: unknown): PublicationDispatchEnvelope;
export function publicationDispatchEnvelope(
  trustedWorkflow: PublicationDispatchEnvelope["trustedWorkflow"],
  intent: PublicationIntent,
): string;
export function publicationSourceRequest(
  env: Record<string, string | undefined>,
): PublicationSourceRequest;
export function createPublicationSourceFact(
  request: PublicationSourceRequest,
  inventory: unknown,
  projection: PublicationSourceFact["projection"],
): PublicationSourceFact;
export function validatePublicationSourceBinding(
  record: Record<string, unknown>,
  expected?: Record<string, unknown>,
): PublicationSourceFact | undefined;
export function publicationSourceReuseIdentity(
  fact: PublicationSourceFact | undefined,
):
  | Pick<
      PublicationSourceFact,
      "validationPurpose" | "publicationSelection" | "inventoryDigest" | "projection"
    >
  | undefined;

export type PublicationNpmObservation = {
  name: string;
  version: string | null;
  required: boolean;
  observedAt: string;
} & (
  | {
      outcome: "observed";
      state: {
        packageExists: boolean;
        hasVersionHistory: boolean;
        selectedVersionExists: boolean;
        latestVersion: string | null;
      };
    }
  | { outcome: "unavailable"; error: string }
);
export interface PublicationClawHubObservation {
  name: string;
  version: string;
  observedAt: string;
  state: {
    packageExists: boolean;
    alreadyPublished: boolean;
    hasTrustedPublisher: boolean;
    trustedPublisher: {
      provider: string | null;
      repository: string | null;
      workflowFilename: string | null;
      environment: string | null;
    } | null;
  };
}
export interface PublicationPlanningSummary {
  all: Array<{ name: string; version: string; alreadyPublished: boolean }>;
  candidates: string[];
  skippedPublished: string[];
  warnings: string[];
}
export interface PublicationObservationCollection {
  sourceDigest: string;
  prerequisitesCompletedAt: string;
  collectionStartedAt: string;
  collectionCompletedAt: string;
  npm: PublicationNpmObservation[];
  clawhub: PublicationClawHubObservation[];
  pendingAuthority: Array<{
    registry: "npm" | "clawhub";
    name: string;
    action: string;
    status: "unresolved";
  }>;
  plans: {
    npm: PublicationPlanningSummary;
    clawhub: PublicationPlanningSummary & {
      bootstrapCandidates: string[];
      missingTrustedPublisher: string[];
    };
  };
}
export interface PublicationObservations extends PublicationObservationCollection {
  kind: "openclaw.full-release-publication-observations/v1";
  contract: "1";
}
export interface PublicationObservationArtifact {
  id: string;
  name: string;
  digest: string;
  sizeInBytes: number;
}
export interface PublicationAdmission {
  observations: PublicationObservations;
  binding: {
    kind: "openclaw.full-release-publication-admission/v1";
    contract: "1";
    repository: string;
    parentRunId: string;
    parentRunAttempt: number;
    workflow: { path: string; event: string; ref: string; sha: string };
    sourceDigest: string;
    observationsDigest: string;
    artifact: PublicationObservationArtifact;
    admittedAt: string;
    status: "admitted-for-validation";
  };
}
export function publicationAdmissionContract(source: string): "1" | undefined;
export function publicationObservationJson(value: unknown): string;
export function publicationPendingAuthority(
  source: PublicationSourceFact,
  registry: "npm" | "clawhub",
  row: {
    name: string;
    version: string | null;
    state:
      | Extract<PublicationNpmObservation, { outcome: "observed" }>["state"]
      | PublicationClawHubObservation["state"];
  },
): PublicationObservationCollection["pendingAuthority"][number] | null;
export function createPublicationObservations(
  source: PublicationSourceFact,
  observations: PublicationObservationCollection,
): PublicationObservations;
export function createPublicationAdmission(
  source: PublicationSourceFact,
  observations: PublicationObservations,
  artifact: PublicationObservationArtifact,
  admittedAt: string,
): PublicationAdmission;
export function validatePublicationAdmissionBinding(
  record: Record<string, unknown>,
  expected?: Record<string, unknown>,
): PublicationAdmission | null | undefined;
