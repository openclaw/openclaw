## Rejected Experiments

- **UI blobless sparse checkout (2026-10-16):** Excluding native mobile/macOS
  app trees removed 48.31 MiB of logical tracked content, but did not qualify as
  a runner-cost improvement. In
  [run 38866595993](https://github.com/openclaw/openclaw/actions/runs/38866595993),
  the Blacksmith UI E2E checkout took 56s and the hosted browser checkout 58s;
  same-run full UI checkouts took 22–38s. These are small, unpaired samples,
  not a measured billing delta. Keep the full source checkout. Reconsider only
  with lower complete checkout time and billed cost, including filtered fetch,
  lazy materialization, and trusted-harness export; fewer logical bytes alone
  do not establish savings.
- **Declaration-fixture owner selection (2026-10-02):**
  `test/scripts/tsdown-declaration-fixture.ts` derives real source copies from its runtime
  entrypoint closures, so product PRs that edit one do not select the four declaration suites
  built on it. [PR #162614](https://github.com/openclaw/openclaw/pull/162614)
  broke `write-unified-entry-dts` that way; hourly scheduled CI
  ([run 36979748808](https://github.com/openclaw/openclaw/actions/runs/36979748808))
  caught it about 35 minutes after merge and `0a188c4f038f0` repaired the
  fixture within the hour. Declaring the owners as `new URL(..., import.meta.url)`
  literals reaches the suites only below aggressive selection's 20-importer
  hub cutoff: the incident owner and seven others are hubs, so the replayed
  #162614 diff still selected none. Replaying all 92 main commits from the
  prior 30 days that touched an owner through the canonical PR planner options,
  URL literals newly covered 12 (+35 rows, +1,689 class-vCPU-minutes). Full
  coverage, such as a policy watch over the same list, newly selects the suites
  for 81 and starts `build-artifacts` (median 330s on the 16-class across 12 PR
  runs) for 69, because the suites are build owners in `ci-build-manifest.mjs`:
  +242 rows and +11,628 class-vCPU-minutes, a median +161 (+8%) per affected
  PR. That buys one escaped owner break in seven weeks, so keep the plain
  paths; hourly scheduled CI, tooling-owner PRs and release validation own this
  proof. Reconsider with a materially higher escape rate or a selection that
  does not also start `build-artifacts`.
- **Boundary asynchronous input preparation (2026-09-26):** Adding the existing
  `CompilerInputSnapshot.prepare()` calls at the three declaration/boundary
  callers increased full cold validation from 464.21s to 544.68s on the same
  four-CPU/15.42-GiB Testbox; warm validation increased from 12.62s to 14.63s.
  All 125 plugin checks and the canary passed, but CPU use also increased.
  The six caller additions were removed. Do not repeat this as an assumed
  speedup; any different use needs measured end-to-end benefit.
- **Windows pnpm store (2026-09-20):** Original receipts from
  [run 35547255790](https://github.com/openclaw/openclaw/actions/runs/35547255790)
  measured median complete setup at 45.295s cold versus 52.738s restored
  (+16.4%), despite reusing all 1,453 packages with zero downloads. The
  763.8-MiB archive took 23.601–26.980s to restore; producer setup/save added
  62.527s. All seven native jobs passed, but the qualification reducer failed
  on a 24-KiB reported-RAM difference. No assertions were relaxed or jobs
  rerun. The exactly RAM-matched subset was still 11.3% slower; that is
  descriptive evidence, not a replacement passing qualification. Keep normal
  Windows setup uncached. Reconsider only with net complete-setup savings,
  including restore, extraction, frozen reconciliation, and producer work.
- **Hosted Mac exact dependencies (2026-09-01):** The same-head publisher and
  consumer in [run 33458856298](https://github.com/openclaw/openclaw/actions/runs/33458856298)
  successfully saved and restored a 1.66-GB dependency archive, but setup took
  142s versus 86s with the ordinary store cache. Extraction took 82s versus 27s;
  install improved only from 43s to 35s. Keep hosted Mac jobs on the ordinary
  store cache. Reconsider only with measured total setup savings, including
  transfer, extraction and frozen reconciliation, not a successful cache hit.
- **Actions-artifact checkout (2026-08-16):** Do not recommend replacing the
  shared Blacksmith Git fetch with a preflight-produced workspace or `.git`
  artifact. [PR #124818](https://github.com/openclaw/openclaw/pull/124818)
  measured a 16s Blacksmith checkout baseline versus 7s hosted. The best direct
  artifact variant cost 1s to pack, 3s to upload, and 11s median to restore;
  including the serial prefix left only about 1s median improvement and
  regressed Blacksmith's fast-fetch runs. The official artifact client was
  worse: [run 31971531521](https://github.com/openclaw/openclaw/actions/runs/31971531521)
  measured 22s median download plus 2s materialization. Blacksmith's fast
  Actions-cache path does not imply fast Actions-artifact downloads. Reconsider
  only with measured end-to-end proof for a different transport, including its
  producer cost and fast-fetch regressions.
