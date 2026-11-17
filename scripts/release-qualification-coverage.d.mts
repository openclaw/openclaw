import type { QualificationCoverage } from "./release-qualification-admission.mjs";
export const QUALIFICATION_COVERAGE_PATH: "scripts/lib/release-qualification-coverage.json";
export function qualificationAdmissionContract(source: unknown): "1" | undefined;
export function validateQualificationCoverage(value: unknown): QualificationCoverage;
export function qualificationCoverageSha256(value: unknown): string;
export function resolveQualificationCoverage(
  policy: unknown,
  inputs: Record<string, string | number | boolean>,
): QualificationCoverage;
export function validateQualificationJobs(
  jobs: unknown,
  requiredNames: string[],
  label?: string,
  waivedJobNames?: Set<string>,
): void;
export type QualificationChildCompletenessContext = {
  role: string;
  inputs: Record<string, string>;
  /** Read immutable Q source, not the current publisher checkout. */
  getSource: (path: string) => string;
  /** Read immutable survivor directory names at the admitted candidate C. */
  getCandidateFileNames: (sha: string) => string[];
};
export function qualificationRequiredChildJobs(
  context: QualificationChildCompletenessContext,
): string[];
export function validateQualificationChildCompleteness(
  context: QualificationChildCompletenessContext & { jobs: unknown; waivedJobNames?: Set<string> },
): void;
