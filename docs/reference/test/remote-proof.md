---
summary: "When agents use Crabbox or Testbox, and the wrapper, lease, and trust rules"
title: "Remote test proof"
read_when:
  - You are deciding between local and remote proof
  - You are running OpenClaw tests on Crabbox or Testbox
---

<a id="agent-default" />

## Remote proof policy for agents

Use the canonical
[proof policy](https://github.com/openclaw/openclaw/blob/main/.agents/skills/openclaw-testing/SKILL.md#proof-policy)
to decide whether remote proof is needed. The procedures below apply only to
that exception. Never execute untrusted repository tooling locally; use
secretless fork CI or sanitized direct AWS, never credential-hydrated Testbox.

Acquire only when the command is ready; reuse task-owned leases and stop them
before handoff. Finish commands and cleanup before syncing or reusing a lease.

Testbox `run` and `warmup` use the workflow from `main` so new allocations
inherit the maintained spending limits. The wrapper overrides configured workflow
refs and rejects an explicit `--blacksmith-ref` other than `main`. Choose the
source revision in your local checkout; its source capsule and frozen dependency
install preserve that selection independently of the workflow ref. Explicit
workflow and job selection still support the high-memory profile.

At allocation, the wrapper records the caller task, physical checkout, HEAD,
base, dependency inputs, and Testbox preparation fingerprint under
`.crabbox/testbox-leases/`. Reuse requires the same task, checkout, base,
dependencies, preparation, and workflow inputs, including immediately before
delegation. Source-only edits and commits can reuse that prepared box. The
allocation receipt remains unchanged, while each command records its current
source revision and syncs the checkout. Source edits during preparation are best
effort; finish editing before starting proof, or rerun from the intended candidate.
This source-refresh contract belongs to the OpenClaw wrapper's trusted task
path; it does not permit raw native callers or untrusted proof to reuse a
lease across revisions.
Older or missing receipts require stopping the owned lease and allocating a
fresh one through the wrapper. `OPENCLAW_TESTBOX_ALLOW_STALE` cannot bypass
these checks. All providers require Crabbox 0.73.0 or newer.

The Testbox workflow registers a separate disposable checkout for native sync.
The hydrated execution workspace stays at its original absolute path, so native
Git cleanup and rsync cannot delete dependencies, build output, or ignored runtime
there. The wrapper applies and verifies the source bundle in that execution
workspace, runs its frozen dependency install, and checks the source and Git
identity again before the payload. Install output goes to stderr; an install or
verification failure stops the payload. It never restores runtime from the caller
or changes the selected rsync binary.

Workspace preparation changes require a fresh lease. A missing or overlapping
execution-workspace binding stops the payload; stop that lease and warm a new one.
Use the OpenClaw wrapper for proof: direct native Blacksmith commands target the
transport checkout, which deliberately has no hydrated runtime.

Testbox requests with `--artifact-glob` or `--require-artifact` collect from the
prepared execution workspace. Collection stays anchored there across payload
directory changes and normal failure exits; existing cancellation and
signal-related artifact withholding remains unchanged.

The wrapper uses the bundled Crabbox plugin to update missing or outdated CLI
binaries before provider discovery, source sync, or lease work. Every command uses
the current supported CLI contract; there are no separate version requirements
for artifacts, providers, or `sync-plan --json`.

Testbox runs and POSIX remote changed gates freeze source into a Git bundle
against the pinned base.
Selection uses Crabbox's sync policy and Git's repository, info, and effective global
exclusions, including repo-local overrides, for untracked files. Tracked ignored
files and staged ignored additions remain source; an explicit privacy exclusion
conflicting with required tracked source stops the run before upload.

The command binds the bundle digest and raw source tree. Before running the payload,
the receiver applies deletions and restores file bytes, symlink target bytes, and
Git executable modes, then verifies the filesystem directly. Git text filters do not
normalize this snapshot. Missing, stale, or mismatched bundles fail closed.
Producer-declared deletions must also be absent, even when the remote index has lost
them. Deletions use the same privacy policy as source selection; unknown ignored
runtime data is preserved. Unexpected nonignored receiver files stop the run instead
of being deleted. The verification receipt reports the original source revision
separately from the synthetic transport commit; remote `HEAD` identifies that
verified transport tree, and changed gates compare it with the pinned base.
Raw-byte differences can conservatively select additional changed paths. Git path
names must be UTF-8; symlink targets remain raw bytes. Symlinked repository Crabbox
configuration or ignore files, and privacy-excluded runtime configuration, are
rejected before upload rather than changing their trust or privacy treatment.

See [local commands](/reference/test/local) for focused development proof.

For untrusted proof, lazily warm with `--provider aws`. Every run must set
`CRABBOX_ENV_ALLOW=CI`, pass `--provider aws --no-hydrate`, and use
a fresh temporary remote `HOME` before installing dependencies or running
tests. Use a newly warmed lease dedicated to that untrusted source; never reuse
a trusted or previously hydrated lease. Launch an installed trusted Crabbox
binary from a clean trusted `main` checkout and fetch only the remote PR with
`--fresh-pr`; never execute the untrusted checkout's wrapper or config locally.
Unset `CRABBOX_AWS_INSTANCE_PROFILE` and fail closed unless resolved
`aws.instanceProfile` is empty. Before any install/test, use trusted
absolute-path tools to require an IMDSv2 token, prove the IAM credentials
endpoint returns 404, and verify remote `git rev-parse HEAD` equals the full
reviewed PR head SHA. Bind the lease to that SHA and stop/rewarm when the head
changes. Upload trusted `scripts/crabbox-untrusted-bootstrap.sh` from clean
`main` alongside `--fresh-pr`; it installs pinned Node/pnpm, verifies the SHA
and package-manager pin, isolates `HOME`, installs dependencies, then executes
the requested test. If the broker cannot prove no role or no remote PR exists,
use secretless fork CI. Do not use `hydrate-github`, `--no-sync`, or a
credential-hydrated Testbox workflow.
Unset all `CRABBOX_TAILSCALE*` overrides, force `--network public
--tailscale=false`, clear exit-node/LAN flags, and require `crabbox inspect` to
report public networking with no Tailscale state before uploading any script.

## Testbox runner sizing

Use the default 16-class workflow for routine remote proof, with a 60-minute
total-job deadline including hydration. Keep the 32-class
rare: record the command and its measured memory need, a smaller-runner OOM,
or a controlled comparison showing lower total billed cost before selecting it.
Existing memory-heavy full-suite Testbox PR gates use this exception. A generic
failure, queue delay, or timeout is not a sizing signal. Keep resource-based
worker limits; do not force higher parallelism on the smaller machine.

Select the exception explicitly with a fresh lease:

```bash
node scripts/crabbox-wrapper.mjs run \
  --blacksmith-workflow .github/workflows/ci-check-high-memory-testbox.yml \
  --blacksmith-job check --idle-timeout 15m \
  --label <task-and-memory-reason> --timing-json -- <command>
```

The high-memory profile uses at most four of the shared 32 Testbox concurrency
slots. Both profiles cap idle time at 15 minutes. Routine proof defaults to
60 minutes; the explicit high-memory workflow retains its four-hour deadline
for known heavy gates. The standard workflow accepts an explicit
`timeout_minutes` input up to 240 minutes, but Crabbox does not forward arbitrary
workflow inputs and `--ttl` does not extend a Testbox job. Do not select a larger
runner merely for more time. Direct-provider `--class` and `--type` flags do not size Testboxes;
workflow selection owns the runner. A profile change needs a fresh lease.
See [runner limits](/ci/runners#testbox-spending-limits) for queue behavior.

## Crabbox repository setup

The [Crabbox skill](https://github.com/openclaw/openclaw/blob/main/.agents/skills/crabbox/SKILL.md)
owns portable lease, trust, sync, and cleanup procedures. This section owns the
OpenClaw wrapper and workflow inputs. Routine task-needed Crabbox/Testbox use
and task-owned worktrees do not require another confirmation; preserve unrelated
work and existing credential, production, budget, and publication boundaries.

Run trusted OpenClaw remote proof through the wrapper from the repository root:

```bash
node scripts/crabbox-wrapper.mjs run --help
```

Read `.crabbox.yaml` and the resolved provider before running. The repository
default is `blacksmith-testbox`, with `.github/workflows/ci-check-testbox.yml`
owning its prepared environment. Direct providers use
`.github/workflows/crabbox-hydrate.yml`. Keep the resolved provider unless the
requested proof requires another environment; capacity or hydration failure
does not make a different provider equivalent.

When provider readiness fails, the wrapper reports the failed or missing doctor
check names with bounded, sanitized messages and classification hints. Successful
checks and other provider details are omitted; a count identifies additional
failures beyond the summary limit. Errors retain the doctor exit status and
recovery instructions, including login guidance for broker authentication failures.
Use `crabbox doctor --provider <provider> --json` to inspect the full report locally
before sharing it.

The direct `.github/workflows/windows-blacksmith-testbox.yml` workflow runs
native Windows. The wrapper's Blacksmith adapter supports Linux only; explicit
`--provider blacksmith-testbox` prevents automatic Azure routing but does not
enable Windows support. As checked on 2026-09-01, Blacksmith CLI 0.4.57 targets `runner`
and has no native username override, so supported CLI sync/run on this Windows
image remains blocked. Recheck against a newer CLI before relying on this. Native SSH inspection with the per-Testbox key is not CLI end-to-end
proof.

The wrapper checks an executable sibling `../crabbox/bin/crabbox`, then `PATH`,
then the sibling of the Git common checkout. Verify the selected binary and
its source rather than trusting a directory name. The plugin installs a verified
managed copy when the selected executable is missing or outdated. For an explicit
[Crabbox](https://github.com/openclaw/crabbox) source repair, build `./cmd/crabbox`
in a clean task-owned checkout and leave the operator's installation untouched. The existing
`OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY=1` setting skips the first sibling
candidate; a task binary on `PATH` then takes precedence over the common-checkout
candidate. A dirty or occupied sibling is not a reason to stop and ask.

Mantis uses the same plugin-owned discovery and managed installation. Relative
executable overrides and `PATH` entries resolve from its requested `--repo-root`,
and version checks run there with the same environment as lease commands. Its workflows
prepare the executable with `node scripts/crabbox-setup.mjs`; the command prints
the selected binary and verified version as JSON and, in GitHub Actions, adds its
directory to `GITHUB_PATH`. Later QA and media commands reuse that executable.

For a selected trusted Testbox lane:

```bash
node scripts/crabbox-wrapper.mjs run --timing-json -- \
  CI=1 NODE_OPTIONS=--max-old-space-size=4096 \
  OPENCLAW_VITEST_MAX_WORKERS=1 \
  OPENCLAW_TESTBOX=1 OPENCLAW_TESTBOX_REMOTE_RUN=1 \
  pnpm test <path-or-filter>
```

For several commands, use a unique task label and retain the first allocation:

```bash
node scripts/crabbox-wrapper.mjs run --provider blacksmith-testbox --keep --label <task-name> -- <first-command>
node scripts/crabbox-wrapper.mjs run --provider blacksmith-testbox --id <tbx_id> --label <task-name> -- <next-command>
node scripts/crabbox-wrapper.mjs stop --provider blacksmith-testbox <tbx_id>
```

Use the returned lease ID and the same label throughout the task. Codex, Claude
Code, and GitHub Actions also bind reuse to their session or run identity.
Session-owned `warmup --timing-json` can allocate without a label; human shells
use the labeled `run --keep` flow above. Stop has no `--timing-json`.

- Warm from the task checkout. Claims belong to checkout paths; `--reclaim`
  deliberately transfers that ownership and never changes repository identity.
  After a temporary-source run, the wrapper restores retained Blacksmith and
  AWS lease claims to the invoking checkout. A claim transferred elsewhere is
  left untouched. Do not sync or reclaim while another command owns the lease.
- Wrapper reuse requires the local SSH key created by Crabbox. A missing key
  requires a fresh warmup. Leases created directly by Blacksmith remain usable
  through `blacksmith testbox run --id <tbx_id>`, not Crabbox wrapper reuse.
- Every native Testbox run syncs again, including reused leases. `--no-sync`
  cannot preserve a remote baseline. Compare revisions in separate remote
  worktrees within one synced command; never switch refs in the synced root.
- Compound remote shell commands use `bash -lc`, not `sh -lc`; hydration can
  depend on Bash declarations. Testbox's workflow owns Chromium, so do not pass
  Crabbox `--browser` to that provider.
- Keep the lease fingerprint checks described above. No stale-lease override
  for release proof. Direct-provider flags such as `--fresh-pr`, `--full-resync`,
  `--script*`, `--env-helper`, capture/download flags, and `--stop-after` are not
  a substitute for the delegated Testbox workflow.
- For Testbox scripts, run a synced file as trailing command arguments or use
  `--shell`. Active `--script` and `--script-stdin` uploads are rejected before
  source preparation or lease work.

Blacksmith source capsules keep one private mirror per physical source worktree
under the configured sync root. Later runs enumerate source eligibility again,
compare file identity, size, timestamps, mode, and kind, and copy and hash changed
files. Unchanged source stays in place with warm Git index stat data. Git's staged
tracking and the final raw transport tree use separate indexes, preserving the
same ignored-file and untracked-file selection rules. The wrapper reports copied
and reused file counts and preparation time.
Commits on the same retained source ref keep the mirror reusable; each command
records its captured source witness.

The mirror remains exclusively locked for the entire command, including artifact
preservation and lease-claim restoration. An overlapping run from the same worktree
prints a message and builds an independent fresh capsule. Only completed cleanup
records an idle mirror for reuse; a missing witness, unsupported staging location,
or unresolved owner uses fresh staging. Avoid editing source during freezing;
the capsule uses its captured selection and bytes without a final source rescan.
Cache metadata, payload, witness repository or ref, or Git-version mismatches
rebuild cold before upload. Source enumeration and metadata checks still scale with the repository;
source-byte copying and hashing scale with changed files on warm runs.
Private mirrors disable Git hooks and fsmonitor; source enumeration also disables
fsmonitor in mirror mode. Other active Git callbacks retain the preparation hold
and cannot make a reusable cache. Ordinary fresh-capsule behavior is unchanged.

Different worktrees share a short allocation lock. A busy allocator prints
`[crabbox] waiting for source mirror allocation...` and waits up to 120 seconds
before falling back to a fresh capsule. Per-mirror validation, cold preparation,
and eviction's payload deletion run under the slot lock without holding allocation.

The sync root admits at most 32 mirror slots. Allocation evicts the least
recently used idle mirror; active, corrupt-ownership, or interrupted slots remain
protected and count toward the limit. If no slot can be safely reclaimed, the run
uses ordinary fresh staging. `staging inspect` identifies idle mirrors, and
`staging recover <id>` can remove one under its exclusive lock. Automatic abandoned
staging recovery leaves idle mirrors available for reuse. Interrupted commands
retain the existing witness, claim, and diagnostic recovery requirements.
An eviction records disposal before deleting bytes and keeps its slot reserved
until deletion finishes. If interrupted, `staging inspect` reports the recorded
disposal as a recovery candidate; automatic recovery or `staging recover <id>`
can resume it after acquiring the exclusive slot lock. Replaced directories and
unknown metadata remain protected. Concurrent allocators recheck capacity after
deletion; a slot being disposed still counts toward the 32-slot limit.
A separate disposal receipt survives the final directory and lock removal, so
recovery can finish interrupted namespace cleanup even after the payload receipt
is gone. Recovery preserves an already-recorded disposal instead of rewriting it.
Slots whose producer already removed the payload also receive a cleanup record;
that record requires the payload root to stay absent and never authorizes deleting
a replacement root. Both forms block slot reuse until cleanup completes.
Private Git objects reaching 256 MiB trigger a cold rebuild on the next reuse,
bounding retained object history without pruning objects behind saved indexes.

When remote sync uses an isolated checkout, the wrapper preserves native
`.crabbox/runs` and `.crabbox/captures` outputs together beneath a fresh
`.crabbox/wrapper-artifacts/run-*` directory before removing that checkout or
returning its mirror to the idle cache. Verified native outputs are removed from
an idle mirror so later runs retain only their own diagnostics.
Other native `.crabbox` state uses ordinary full checkout disposal after artifact
preservation; the next run builds a cold mirror. Mirror locks release automatically
when their process exits, but an unresolved admitted consumer still requires the
existing staging recovery checks before its snapshot can be removed.
Repeated runs retain separate evidence even when native filenames match. The
wrapper prints the old-to-new root mapping; native logs and generated proof may
still reference the old paths. A preservation error fails the wrapper and retains
the temporary checkout at the reported path for manual recovery, preserving the
child's nonzero exit code. The wrapper rejects symlinks in artifact trees
and destination parents, and copies only regular files and real directories.
Retained files use mode `0600` and new directories use `0700` on POSIX systems.
If preservation fails, recover the outputs from the reported checkout before
removing it. Recognized unchanged partial copies are removed; a partial destination
that cannot be verified is retained and reported with the original outputs.

On normal completion or a supported POSIX interrupt, the wrapper settles its
child process tree and output streams before restoring retained lease ownership, preserving
artifacts, and removing disposable source. Allow the wrapper to finish after
Ctrl-C; additional signals reuse that shutdown and its bounded escalation.
A package-manager proxy can return its interruption status before the wrapper
finishes. That status or remote lease completion alone does not establish that
local cleanup finished.

Cleanup errors are reported and make an otherwise successful invocation fail;
an existing nonzero command or cancellation status is preserved. If child
termination cannot be verified, the wrapper retains its local inputs and reports
that recovery is needed. A failed retained-lease ownership restore also retains
the checkout; restore that lease to the original repository or stop it before
removing the checkout. Stop any remaining owned processes before recovering
artifacts or removing their temporary inputs.

The wrapper records future temporary checkouts only when staging is provably
outside the source repository, using private recovery metadata beside the payload.
The default `~/.cache/openclaw/crabbox-sync` location normally meets this condition.
Configured repo-local roots, including ignored directories such as `.artifacts/`,
continue to work through ordinary unmarked staging and cleanup. They receive no
recovery receipts or manifests and remain protected after abrupt loss. Uncertain
placement also uses that compatible unmarked path.

Changing the configured root or ignore rules does not create new recovery metadata
inside the repository. Existing copies at another root are not moved or adopted;
select that root to inspect them. This feature does not filter existing user data,
broader source scopes, or explicit raw workspace mounts. Inspect recorded copies with:

```bash
node scripts/crabbox-wrapper.mjs staging inspect
node scripts/crabbox-wrapper.mjs staging recover <id>
```

These local commands use the existing Crabbox binary without installing it,
starting a provider, changing claims, or stopping a lease. Recovery checks the
original native claims namespace, verifies a recorded snapshot against an
independently retained Git ref, and verifies saved diagnostics before deleting
unchanged staging. A claim that still names staging requires an operator to stop
the exact lease or explicitly reclaim it from the real repository, then retry.
Changing `HOME` or `XDG_STATE_HOME` cannot establish absence in the old namespace.

A prepared capsule with no admitted consumer can be recovered after its owner
disappears. An admitted consumer requires a persisted writer-settlement receipt.
Git configurations that may launch preparation helpers, or additional local Git
seed preparation, remain held because parent-command completion does not certify
those helpers. Their ordinary execution is unchanged. Earlier experimental
receipt versions also remain protected.
Explicit recovery can retry pending diagnostic preservation after a destination
problem is repaired. Automatic recovery leaves artifact or claim failures held.
Missing or changed saved outputs prevent removal; recovery never recreates a
vanished original repository to invent a preservation destination.

Dirty source requires another complete retained copy. After deliberately retaining
that snapshot in an independent Git repository and named ref, select it explicitly:

```bash
node scripts/crabbox-wrapper.mjs staging recover <id> \
  --witness-repo /path/to/retained-repository --witness-ref refs/heads/saved-source
```

Witness verification proves that the selected ref's objects are present and connected.
On Git 2.50+, it skips unrelated reference-database checks, so stray files such as
Finder `.DS_Store` under `.git/refs` do not block recovery. Explicit `staging recover`
scales its work budget with witness object storage: 120 seconds plus 30 seconds per
GiB, at most 30 minutes. Automatic recovery after a wrapper command keeps the
120-second bound.
Failure reasons distinguish an exhausted budget, reference-database errors, and
missing or unconnected objects.

Recovery does not create backup repositories, archives, or permanent refs. A stage's
own Git objects or bundle do not count as another copy. Live or uncertain owners,
unrecorded writer settlement, interrupted recovery ownership, substituted metadata,
other hosts or PID namespaces, and historical unmarked directories remain protected.
New receipts record platform, stable host identity, boot ID, and PID namespace.
A different boot on the same host and PID namespace proves the old producer is
absent; recovery does not probe its potentially recycled PID. Same-boot recovery
still checks PID absence. Missing host provenance and legacy domain mismatches
remain protected unless explicitly qualified below.
Idle mirrors retain their separate exclusive-lock recovery contract. Directory
ownership records include the canonical path, inode, birthtime, and macOS volume
UUID, so APFS device-number changes across reboots do not invalidate that identity.
Legacy device/inode records accept a macOS device-only change only when the
directory predates its receipt and the existing path and ownership checks pass.
Inspection never rewrites receipts; successful owner updates persist the stronger
identity and retain the original timestamp bound for remaining legacy evidence.
Changed identities, unknown siblings, and incomplete metadata remain protected.
If a recorded volume UUID cannot currently be verified, recovery also remains
protected until the OS volume lookup succeeds.
Full worktrees also remain
protected because hooks, filters, and raw source require separate proof. Their
ordinary cleanup retains the remaining staging if exact Git registration removal
fails, including its receipt when registration was eligible. Repo-local copies
remain unmarked. There is no global worktree prune or blanket force-recovery option.

For one legacy capsule from an earlier boot of this host, inspect eligibility first:

```bash
node scripts/crabbox-wrapper.mjs staging inspect <id> --same-host-prior-boot
```

This is read-only: it does not create locks, update receipts, preserve outputs, or
delete staging. It returns `eligible`, the exact `receiptSha256`, and any refusal.
Only after reviewing that specific copy, confirm the same host and prior boot:

```bash
node scripts/crabbox-wrapper.mjs staging recover <id> \
  --confirm-same-host-prior-boot --receipt-sha256 <digest-from-inspection>
```

Confirmation requires a pre-boot receipt mtime, a different legacy domain when
recorded, current host/boot evidence, and matching UUID-backed sync-root and
directory identities. UUID-unavailable filesystems cannot use this legacy path.
The original timestamp is retained across confirmed retries; each retry still
requires a new explicit confirmation bound to the current receipt bytes.
The confirmation is recorded in the receipt and command result, never reused as
automatic authorization. It does not replace metadata completeness, settlement,
native-claim, independent-source, or diagnostic-preservation checks.

Recovery checks local users with bounded `lsof` scans and refuses live users,
incomplete output, or unavailable inspection. Only the recovery process's exact
held mirror-lock file is exempt. Recovery reacquires its exclusive locks and
revalidates receipt, identities, and producer-absence evidence after awaited work.
Per-ID `staging inspect <id>` also previews ordinary recovery; idle mirrors and
completed disposal records retain their separate slot-locked workflow.

Source-transfer commands inspect at most 64 bounded headers with a 250-ms soft
discovery budget after the initial volume lookup. This scan does not hash payloads, search Git history, or query a
provider. A temporary cursor advances subsequent scans past protected entries;
`staging inspect --after <nextCursor>` also pages the local report. After successful
normal completion the wrapper attempts at most one discovered candidate. Help,
listing, version output, and cancellation do not start old-stage recovery, and a
recovery failure does not change the completed command's result. Inspection reports
incomplete scans and elapsed time; bulk verification is separately bounded and can
take longer. Unsupported filesystem durability, including native Windows directory
flushes, prevents orphan recovery while preserving ordinary operation. Normal
cleanup still removes its own successful or dirty-source staging without requiring
an independent recovery witness.

These are local artifacts, not published or fully sanitized proof. Blacksmith's
native failure bundle contains captured stdout/stderr and diagnostic metadata;
it does not automatically include remote UI screenshots or reports. Retrieve
those separately before stopping the owned Testbox, and inspect all artifacts
for secrets and private data before sharing.

The native Windows Testbox idle monitor uses the running `sshd` service's local
listener ports, not Blacksmith's externally forwarded SSH port. Established SSH
connections keep the job alive; the `~/.testbox-last-activity` modification time
covers short commands between the 30-second polls. Once neither indicates recent
activity, the configured idle timeout still ends the job.

The shared skill's command placeholders map to the focused commands in this
guide. Its trusted bootstrap is `scripts/crabbox-untrusted-bootstrap.sh`; the
untrusted path above invokes the installed trusted CLI, never the PR's wrapper.
For an explicitly selected local-container lane, the existing example image is
`node:24-bookworm` and the install command is
`corepack pnpm install --frozen-lockfile --store-dir .pnpm-store`, followed by
the chosen test. Keep `--no-hydrate` and a repository-local dependency store
when host caches cannot cross filesystems. The OpenClaw broker login endpoint
is `https://crabbox.openclaw.ai`; normal brokered validation does not require
asking for AWS keys.

Live Gateway, channel, and agent-turn proof uses an isolated
`OPENCLAW_STATE_DIR`, a free port, and the real user path. Test-only plugin
artifacts may use `OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES=1`; that does not make
them official installs. Before sharing WebVNC, inspect a screenshot of the
working app. Keep proof media out of the product repository and compare source
hashes before and after generator runs. If a final timing result is written but
portal synchronization hangs, interrupt only the task wrapper and independently
verify lease cleanup; never stop the operator's Gateway.
