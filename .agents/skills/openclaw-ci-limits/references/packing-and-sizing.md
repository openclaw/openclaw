# Packing and sizing

- Blacksmith and hybrid compact bins with multiple ordinary groups request the
  existing 32-vCPU class and two child slots with an initial 360s aggregate budget.
  Final compaction can combine already-admitted parallel bins within 500s;
  it does not promote serial jobs or change worker limits. Preserve the separate
  300s ordered two-slot queue bound and runtime preparation charge.
  Gateway-exclusive serial bins and native numbered tooling bins use a 300s test
  budget; hourly hybrid main validation packs its tooling rows within 420s plus
  60s setup to keep headroom under its 77-row cap. Native tooling rows containing
  the partitioned changed-Node planner proof retain a 150s test budget through
  initial and measured packing. The partition keeps
  two workers and serial outer admission. Ordinary self-hosted bins share promoted capacity across logical
  classes; the existing group exchange fills stranded slots without raising caps.
  Parallel admission also bounds the ordered two-slot queue at 300 test seconds;
  matrix predictions use that same queue. Admission retains aggregate work caps
  and separately charges the measured 60s runtime preparation.
  Hosted hourly tooling retains its 720s total budget (660s work plus 60s setup)
  with complete hosted file prices and no native wall observations.
  Compatible two-slot bins use the time budget without the ten-group cutoff;
  serial bins retain that cutoff. Blacksmith serial bins retain 200/276s, hybrid serial bins retain 210s,
  exclusive bins retain 150s by default, and groups above their serial cap stay alone.
  Complete ordinary hybrid bins containing only non-build CLI groups may use
  250s and co-locate split siblings, provided each original child still fits
  150s. Keep file splits, workers, process isolation and other profiles unchanged.
  Initial packing separates runtime consumers from ordinary groups. Complete
  hybrid main and PR runtime-placement observations apply only after file splitting;
  precise changed-file templates retain their original capacity and floors.
  Typed observations preserve configs, environment, complete files and build mode.
  Prefer an exact measurement; otherwise use the maximum compatible contained
  workload as an advisory floor, never sum overlaps or treat globs as whole files.
  Whole pinned runtime groups may move to existing compatible ordinary jobs under
  a 360s budget including the 60s build reserve. Keep runner anchors,
  test partitions, invocation counts and worker limits. An ordinary recipient
  becomes serial, explicitly retaining its old parallel groups' two-worker budget
  while preserving their prepared timing identities and complete parent
  generations. The CI executor applies the smaller of the
  supplied job ceiling and group cap. This may add one runtime preparation while
  reducing requested process slots; measure the tradeoff without adding jobs or
  registrations. Equal maximum estimates prefer more recipient headroom.
  Reapply shared family, group-count and budget admission to both replacements;
  never suppress coverage or count a runtime subset as a complete parent.
  An unfit optimization retains the runnable plan and its truthful estimate.
  Compare recipients with the donor job's fixed anchor, not only its group class.
  Exclusive, private-QA, dist and hosted policies stay unchanged.
  Affordable generated CLI runtime children may share one preparation in an
  exclusive serial bin within the same 150s budget; fixed stripe families remain
  separate. Other hybrid exclusive/dist sharing is unchanged. Complete inventories
  remain intact.
  The canonical shard executor admits two CI children only with at least eight
  available CPUs and 24 GiB actual memory; otherwise it admits one. Inner project
  parallelism stays one during outer overlap and each overlapping child keeps two Vitest workers.
  A serial changed-extension envelope may overlap two source-only Telegram database-worker
  singleton processes, retaining two workers per process, only with scheduler-owned caches,
  at least two actual CPUs and 7.5 GiB effective memory (the smaller of physical memory and
  a positive finite process constraint). Require self-hosted Linux, an explicit current-target
  receipt (`FROZEN_TARGET=false`), and one unchanged Node invocation from the canonical
  runtime selector; `bun-compatible` can still select Node. Other shapes, runtimes and
  unknown/insufficient capacity retain one inner process. Use the actual inner-cap receipt
  in timing identity; parallel envelopes never supply serial singleton or wrapper-overhead
  prices. Keep conservative serial placement until qualified exact parallel measurements exist.
  Gateway methods use four workers in serial, non-frozen self-hosted jobs with
  at least eight actual CPUs and 28 GiB memory, with the existing two-worker
  fallback elsewhere. Keep its worker-specific timing identity and require
  three original-shard replays plus sampled memory evidence when changing it.
  The Gateway server-isolated/database-worker family keeps two workers, including
  roomy serial self-hosted jobs, to leave cold-startup headroom within its existing
  test deadlines. Preserve host admission and fallback rules, other groups' pins,
  hosted planning, complete inventory, cleanup, and old timing generations until
  refit. The historical eight-worker qualification does not establish headroom
  for the current fixture cohort.
  The primary GitHub profile remains serial at 210s. Failed-job-only hybrid
  retries retain the original wider matrix on hosted Ubuntu, clamp to one child,
  and keep two workers per child; they can exceed the eight-minute normal-run
  objective without changing existing deadlines. Fewer jobs must retain native
  elapsed-time, actual memory and cleanup proof; requested labels are not capacity.
- The whole Blacksmith agent-support group requests `blacksmith-32vcpu-ubuntu-2404`.
  Its file inventory and resource-derived worker policy remain unchanged.
- Precisely selected serial CLI, Gateway client/server, and embedded-agent jobs
  use the 16-class when every group has one qualified config, one or two explicit
  files, and a two-worker pin or fallback. An explicit wider pin disqualifies the
  group. Keep build, dist, memory, large-runner anchors, and unqualified configs
  at planned capacity; resource-gated tooling tests are not qualified by this rule.
  Apply capacity after packing; preserve inventories, runtime selection, timing
  identities, and process boundaries. Full families retain their planned capacity.
  RunsOn inherits the hybrid choice for these retained Blacksmith jobs.
  The exact singleton `gateway-core` selection of
  `src/gateway/mcp-app-extension-runtime.test.ts` and `agents-core` selection of
  `src/agents/cli-runner.helpers.test.ts` also qualify under these guards.
  Their five-file serial replay at `137e7b2abc87` passed 56 tests on each of Bun
  and Node, using four CPUs and 15.42 GiB RAM. Whole-machine peaks were 5.00 and
  5.22 GiB, with zero OOM kills and at most 268 KiB swap use. Other files in those
  configs and unbounded or parallel infra selections retain planned capacity.
  Native billed savings remain unverified.
  The isolated LLM-boundary cache-stability file also qualifies when it is the
  group's only file, under the same serial, worker, and preparation guards.
  Its complete current-source replay passed all 19 tests with four CPUs,
  12 GiB RAM, no swap, 4.23 GiB peak, and zero OOMs. Other isolated files,
  including siblings in the same job, retain their planned capacity.
  The singleton `src/gateway/board-store.test.ts` selection also qualifies as the
  job's only group, with an explicit two-worker pin, two-worker fallback, and
  unchanged 28-GiB worker-admission threshold. Its five-test replay passed through
  the CI shard executor in 40.78 seconds on four CPUs and 15.42 GiB RAM. Maximum
  process RSS was 3.17 GiB, not an aggregate VM peak. Keep all other database-worker
  selections and mixed jobs at planned capacity; native billed savings are unverified.
- Source-only serial Blacksmith tooling bins use the 16-class after packing,
  retaining logical classes, names, file inventories, and two-worker pins.
  Keep the 32-class for compiler/artifact capacity files, explicit runner or
  memory anchors, builds, dist, mixed configs, and parallel jobs. Require complete
  file lists; unknown envelopes retain their planned runner. The final capacity
  rule does not change hosted or hybrid plans, packing, timing identities, or
  registration counts. Tooling files use the shared worker scheduler; price their
  current file costs by effective workers without dividing the longest file.
  Docker helper fixtures retain their separate serial config. This does not
  promote hosted or hybrid tooling as a family; capacity alone is not a measured speedup.
  Hybrid compiler fixtures and worker-artifact CI keep their per-file 32-class floor.
  The latter needs eight CPUs / 24 GiB for all six cases, and its two-CPU screen
  exceeded the existing memory reserve before the three resource-gated cases ran.
- Numbered tooling measurements in `toolingFileSeconds` drive file packing with
  native profile costs; a hosted fallback scales measured Blacksmith costs.
  The daily refit samples successful jobs from the newest five contributing
  completed PR CI runs, including workflows where other jobs failed.
  Those measurements describe the PR merge-ref and update exact compact and tooling identities;
  main compact and release sampling retain their existing provenance. Preserve
  independent-run medians, runner profiles and partial-plan history. An explicit
  `--tooling-run <id>` seed records its source and may use one successful run.
  Verbose-only case sums are conservative packing costs when cases overlap,
  not measured file walls. Do not discount them to make row caps pass.
- lower-weight Node/check shards on `blacksmith-4vcpu-ubuntu-2404`.
- heavy retained Linux/Android shards on `blacksmith-8vcpu-ubuntu-2404`.
