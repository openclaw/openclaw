export const QUALIFICATION_ADMISSION_WORKFLOW: ".github/workflows/openclaw-release-prepare.yml";
export const QUALIFICATION_WORKFLOW: ".github/workflows/full-release-validation.yml";
export const QUALIFICATION_ADMISSION_FILE: "qualification-admission.json";
export const QUALIFICATION_ADMISSION_JOB: "Admit frozen candidate qualification";
export const QUALIFICATION_ADMISSION_UPLOAD: "Upload immutable qualification admission";
export type QualificationInputs = Record<string, string | boolean | number>;
export type SemanticQualificationInputs = Record<string, string> & {
  trusted_workflow_json: string;
};
export type QualificationRequestInputs = SemanticQualificationInputs & {
  ref: string;
  expected_sha: string;
};
export type QualificationAdmissionRequest = {
  kind: "openclaw.release-qualification-request/v1";
  repository: string;
  candidateSha: string;
  qualificationSha: string;
  requestId: string;
  transportRef: string;
  reviewed: true;
  inputs: QualificationRequestInputs;
};
export type QualificationAdmissionProducer = {
  repository: string;
  runId: number;
  runAttempt: number;
  workflowPath: string;
  workflowEvent: string;
  workflowHeadBranch: string;
  workflowFullRef: string;
  workflowSha: string;
};
export type QualificationAdmissionDescriptor = QualificationAdmissionProducer & {
  artifactId: number;
  artifactName: string;
  artifactDigest: string;
  artifactSizeBytes: number;
};
export type QualificationCoverage = {
  schema: "openclaw.release-qualification-coverage/v1";
  profile: "beta" | "stable" | "full";
  children: Array<{
    key: string;
    workflow: string;
    name: string;
    parentJobName: string;
    dispatchName: string;
    suffix: string;
    requiredJobs: string[];
  }>;
  requiredParentJobs: string[];
};
export type QualificationAdmission = {
  kind: "openclaw.release-qualification-admission/v1";
  request: QualificationAdmissionRequest;
  producer: QualificationAdmissionProducer;
  operator: { id: number; login: string };
  triggeringOperator: { id: number; login: string };
  inputsDigest: string;
  workflowSourceDigest: string;
  policySourceDigest: string;
  baselinePolicy: {
    candidateVersion: string;
    oldestSupportedBaseline: string | null;
    packageSourceDigest: string;
    policySourceDigest: string;
  };
  coverage: QualificationCoverage;
  coverageDigest: string;
};
export type QualificationAdmissionGh = (args: string[]) => string | Buffer;
export function runQualificationAdmissionGh(args: string[]): string | Buffer;
export function semanticQualificationInputs(
  inputs: QualificationInputs,
): SemanticQualificationInputs;
export function buildQualificationAdmissionRequest(params: {
  repository: string;
  candidateSha: string;
  qualificationSha: string;
  requestId: string;
  transportRef: string;
  reviewed: boolean;
  inputs: QualificationInputs;
}): QualificationAdmissionRequest;
export function validateQualificationAdmissionRequest(
  request: unknown,
): QualificationAdmissionRequest;
export function qualificationAdmissionArtifactName(runId: number, runAttempt: number): string;
export function produceQualificationAdmission(params: {
  request: QualificationAdmissionRequest;
  producer: QualificationAdmissionProducer;
  runGh?: QualificationAdmissionGh;
}): QualificationAdmission;
export function resolveQualificationAdmissionDescriptor(params: {
  repository: string;
  runId: number;
  runAttempt: number;
  workflowRef: string;
  workflowSha: string;
  runGh?: QualificationAdmissionGh;
}): QualificationAdmissionDescriptor;
/** Revalidate live authority for an already authenticated immutable receipt. */
export function revalidateQualificationAdmissionAuthority(params: {
  descriptor: unknown;
  admission: QualificationAdmission;
  runGh?: QualificationAdmissionGh;
}): void;
export function verifyQualificationAdmission(params: {
  descriptor: unknown;
  repository: string;
  candidateSha: string;
  qualificationSha: string;
  workflowRef: string;
  inputs?: QualificationInputs;
  runGh?: QualificationAdmissionGh;
  downloadArchive?: (args: string[]) => Uint8Array;
}): QualificationAdmission;
