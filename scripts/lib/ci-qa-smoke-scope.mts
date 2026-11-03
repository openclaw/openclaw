import { isCiDocumentationPath } from "../ci-changed-scope.mjs";

// QA-owned surfaces keep the smoke lane on PRs and main: the harness and
// scenario data, its matrix/telegram channels, packaging, and CI orchestration.
// Keep this pure policy independent of test inventory and import-graph discovery.
const QA_SMOKE_SURFACE_RE =
  /^(?:extensions\/(?:matrix|qa-lab|telegram)|qa)\/|^scripts\/(?:build-all\.mts|package-openclaw-for-docker\.mts)$|^scripts\/lib\/(?:ci-changed-node-test-plan|ci-qa-smoke-scope)\.mts$|^\.github\/(?:workflows\/ci\.yml$|actions\/)/u;

/** Broad runtime changes wait for release validation; automatic runs select QA owners. */
export function hasQaSmokeAffectingChange(changedPaths: string[]) {
  return changedPaths.some(
    (changedPath) => !isCiDocumentationPath(changedPath) && QA_SMOKE_SURFACE_RE.test(changedPath),
  );
}
