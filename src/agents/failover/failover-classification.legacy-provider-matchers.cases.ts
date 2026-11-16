import {
  legacyFailoverCorpusRows,
  matchesSource,
} from "./failover-classification.corpus.test-support.js";

// Distinct real inputs preserved from matcher-specific suites retired by refactor-02.
export const legacyProviderMatcherCases = legacyFailoverCorpusRows(
  "legacy-provider-matchers",
  matchesSource,
  [[24, "isServerErrorMessage", "status: internal server error", "timeout"]],
);
