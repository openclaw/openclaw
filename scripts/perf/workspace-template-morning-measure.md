# Template prewarm morning replay

`workspace-template-morning-measure.ts` exercises the real managed-worktree and
sandbox-projection owners against seven first-parent main advances. Reuse the
62,000-file repository produced by `sandbox-template-commit-measure.ts`; the
fixture must contain `fixture-base`, its real pnpm lockfile, and its source-dependent
installation script. The input repository is read-only. Every output directory
must be new, and each run clones its own source repository and local origin.

```sh
node --import ./scripts/tsx.mjs scripts/perf/workspace-template-morning-measure.ts \
  --fixture /path/to/synthetic-fixture --output /path/to/new-output \
  --image local-node-pnpm-image --prewarm
```

Run the baseline without `--prewarm` from a full exact-parent checkout with the
same workload script. Run the candidate from its frozen checkout. Disabling the
subscriber in changed production code is not an exact-parent comparison. Never
mix candidate source with baseline compiled workers. Use at least five samples
per arm in counterbalanced order and matched baseline A/A controls on the same
host; record source hashes and the image identity with the campaign results.

The replay preserves seven advances across a logical thirty-minute morning,
including three adjacent advances five seconds apart. Only scheduler idle time
is compressed through its existing clock interface. The base-refresh owner's
real thirty-second freshness interval is preserved; each observed advance waits
at least 30.1 seconds since the preceding completed fetch. Native Git, filesystem,
installation, cancellation, and foreground execution run at actual speed. The
three-push burst preserves its real five-second gaps and fetches only its final
head, as a single source's freshness window would do. Scheduler debounce across
multiple observations is covered separately by its focused tests. The injected
clock advances at real speed during native work and foreground requests, and
uses real timers, so a deadline can start background work during a slow request.
Only settled idle intervals advance through an offset. Nominal later request
waves arrive ninety seconds after each selected push, or later if real work
overruns that deadline. Record any such late arrival instead of changing native
execution speed. This is an owner workload with compressed idle intervals, not
a measurement of a thirty-minute Gateway wall-clock session.

The seed activates managed source-only and sandbox template recipes. Each observed
head is discovered by a real default-base managed request with no explicit commit.
That request's fetch, hydration, template miss, and startup latency are charged to
the foreground. There is no artificial periodic refresh before the first user.
Sandbox consumers register their synthetic session through the normal session
entry writer and call `prepareLocalSandboxWorkspace`, including its reuse,
authority, allocation, and foreground-priority ownership.
After that request settles, the scheduler can prewarm during the following idle
interval. Each later measured wave creates a managed-only consumer and a managed-plus-sandbox consumer for the
same head, with an additional sandbox waiter after the rapid-push burst. An older
commit is requested after the second advance. After the sixth advance, another
older-commit request arrives 100 ms after the background scheduler wake, exercising
foreground priority while native work can still be running. Every consumer must
have the requested HEAD, clean tracked bytes, and, for sandboxes, installation
output derived from that exact source. Managed setup and ignored-file provisioning
are disabled, matching the sandbox source preparation path.

Acceptance requires at least 25% fewer foreground commit-change builds and at
least 30% lower aggregate foreground `templatePrepare` wait, without increasing foreground latency tails or total
process CPU/allocation materially. Report any adverse metric, including canceled
background work; prewarming moves work and may increase total cost. Same-head
waiters must share production builds. Background errors fail the run. Retained
template generations must satisfy the production bound without removing leased
readers; inspect the recorded final registry alongside the owner regression tests.

`results.json` records actual and logical arrival times, whether background work
was still running at each arrival, owner phases, production
preparation diagnostics, host load, exact commits, and final template generations.
The seed is separate. Request-level CPU and allocation overlap under concurrency;
use `wave-*` rows for each concurrent wave and `campaign` for total foreground plus
background work. Summed request `templatePrepare` time describes aggregate user
wait, not total CPU or non-overlapping elapsed work. Diagnostics carrying a
`template.missReason` count actual building callers; joined waiters can still pay
template wait without recording a new build. Main-isolate allocation excludes
workers/native code; process CPU includes JS workers but excludes Git, Docker,
and container CPU. Report these boundaries explicitly.

The script closes its scheduler, retires only builders registered in its isolated
state, closes that state, and removes its generated trees through the native
filesystem owner. JSON and runtime logs remain. Cleanup is outside measured rows.
The workload contains 62,000 payload files / 1,100,004,000 bytes per checkout; it
does not manufacture a 35 GiB agent database or claim full Gateway startup proof.
An APFS run does not establish Btrfs latency or physical write behavior. No Team
data, credentials, configuration, or running Gateway is used.
