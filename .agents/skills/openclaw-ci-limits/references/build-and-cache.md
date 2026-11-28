# Build and cache

- Current-target Control UI locale checks share an already-selected public
  artifact producer on real PR/push/schedule events. Keep verification before
  generators, settle the existing strict/advisory outcomes after build diagnostics,
  and route the logical locale gate to that explicit result. Dispatches, frozen
  and compatibility targets, and standalone locale selections retain their job.
  Hosted row accounting omits only the shared locale row; no build is newly selected.

- `preflight` starts immediately without a debounce or standalone admission job.
  `security-fast` waits for its hosted budget decision and still runs after
  preflight failure unless the workflow was canceled. The protected `vitest-cache-warm` workflow
  publishes the immutable semantic dependency archive after setup succeeds,
  in an independent short job. Dependency and code publishers serialize per
  backend/platform/ref without a workflow-wide lock or cross-platform dependency.
  Hybrid adds a bounded hosted tooling/contract/UI seed and native SDK archive,
  without repeating the full Linux build. Docs-only pushes skip warming. The split
  adds one Blacksmith registration per eligible warmer admission, not per CI job;
  include short-publisher turnover in burst estimates. Preflight and downstream Node jobs are
  restore-only consumers on eligible self-hosted runners. Exact misses and
  hosted paths, including Mac Node jobs, use the ordinary pnpm-store cache.
- Current-target `build-artifacts` uses the existing 16-class after a complete
  four-CPU/15.42-GiB compute proof, including the unchanged parallel verifier wave.
  SDK declaration generation uses one compiler program with its existing heap
  budget and native headroom.
  Eligible frozen or unclassified targets also request 16-class; hosted fallbacks, job counts,
  concurrency and deadlines stay unchanged. Measured compute fit does not prove
  queue savings; observe the next exact-head CI cycle.
- Vitest transform and Node compile caches are restore-only in CI and use
  immutable Actions caches; the main-push/daily/dispatch warmer is their sole
  writer. Build, QA and test orchestration consume its shared Node compile seed.
  PRs create no runtime-cache archives.
- Full compiled-worker seeds retain separate prebuild and postbuild archives.
  The existing protected warmer publishes its already-prepared postbuild full
  generation; only selected artifact-producer source verifiers restore it.
  Runtime workers use separate live/cache slots so they cannot replace that
  full seed. Keep byte, topology, runtime and exact output-path validation, the
  uncached path when no archive arrives, and existing job/worker limits.
