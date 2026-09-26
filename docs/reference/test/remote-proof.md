---
summary: "When agents use Crabbox or Testbox, and the wrapper, lease, and trust rules"
title: "Remote test proof"
read_when:
  - You are deciding between local and remote proof
  - You are running OpenClaw tests on Crabbox or Testbox
---

<a id="agent-default" />

## Remote proof policy for agents

Agent sessions run trusted development tests, changed gates, typecheck/lint,
and builds locally by default, broadening only when the touched contract
requires it. Never execute untrusted repository tooling locally. Use Crabbox
when the environment is part of the proof: clean-machine, install/package,
Docker, E2E, live, desktop, or cross-platform work, or when the operator
explicitly requests remote proof. Do not use Crabbox merely as generic compute
offload. The configured Testbox workflow hydrates credentials, so untrusted
contributor or fork code must use secretless fork CI or sanitized direct AWS
Crabbox instead.

Do not pre-warm for anticipated work. Acquire the backend lazily when the
first environment-sensitive command is ready, reuse the returned `tbx_...` id
for later remote commands, sync the current checkout on every run, and stop it
before handoff.

After the first successful reuse, the wrapper records the lease's base,
dependency, and Testbox workflow fingerprint under `.crabbox/testbox-leases/`.
Source-only edits keep reusing the warmed box. A changed merge base, lockfile,
package-manager input, wrapper, or Testbox workflow fails closed and requires a
fresh lease. Every run still syncs the current checkout.
`OPENCLAW_TESTBOX_ALLOW_STALE=1` is only for intentional diagnostics, not
release proof.

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

The [local test commands](/reference/test/local) are the normal trusted development path. Keep proof
proportional to the touched contract.

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

## Crabbox repository setup

The shared [Crabbox skill](https://github.com/openclaw/agent-skills/tree/main/skills/crabbox)
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
and version probes run there with the same environment as lease commands. Its workflows
prepare the executable with `node scripts/crabbox-setup.mjs`; the command prints
the selected binary and verified version as JSON and, in GitHub Actions, adds its
directory to `GITHUB_PATH`. Later QA and media commands reuse that executable.

For a selected trusted Testbox lane:

```bash
node scripts/crabbox-wrapper.mjs run --timing-json -- \
  CI=1 NODE_OPTIONS=--max-old-space-size=4096 \
  OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 \
  OPENCLAW_TESTBOX=1 OPENCLAW_TESTBOX_REMOTE_RUN=1 \
  pnpm test <path-or-filter>
```

For several commands, warm once with
`node scripts/crabbox-wrapper.mjs warmup --keep --timing-json`, save the returned
lease ID, and reuse it with `run --id <tbx_id>`. Stop the owned lease with
`node scripts/crabbox-wrapper.mjs stop --id <tbx_id>`; stop has no `--timing-json`.

- Warm from the task checkout. Claims belong to checkout paths; `--reclaim`
  deliberately transfers that ownership and never changes repository identity.
  Sparse staging uses the wrapper's ownership path. Do not sync or reclaim
  while another command owns the lease.
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

The mirror remains exclusively locked for the entire command, including artifact
preservation and lease-claim restoration. An overlapping run from the same worktree
prints a message and builds an independent fresh capsule. Only completed cleanup
records an idle mirror for reuse; a missing witness, unsupported staging location,
or unresolved owner uses fresh staging. Changed source during freezing fails the
run. Cache metadata, payload, witness, or Git-version mismatches rebuild cold before
upload. Source enumeration and metadata checks still scale with the repository;
source-byte copying and hashing scale with changed files on warm runs.
Private mirrors disable Git hooks and fsmonitor; source enumeration also disables
fsmonitor in mirror mode. Other active Git callbacks retain the preparation hold
and cannot make a reusable cache. Ordinary fresh-capsule behavior is unchanged.

The sync root admits at most 32 mirror slots. Allocation evicts the least
recently used idle mirror; active, corrupt-ownership, or interrupted slots remain
protected and count toward the limit. If no slot can be safely reclaimed, the run
uses ordinary fresh staging. `staging inspect` identifies idle mirrors, and
`staging recover <id>` can remove one under its exclusive lock. Automatic abandoned
staging recovery leaves idle mirrors available for reuse. Interrupted commands
retain the existing witness, claim, and diagnostic recovery requirements.
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

Recovery does not create backup repositories, archives, or permanent refs. A stage's
own Git objects or bundle do not count as another copy. Live or uncertain owners,
unrecorded writer settlement, interrupted recovery ownership, substituted metadata,
other boot/process namespaces, and historical unmarked directories remain protected.
Recovery is limited to the same boot and a known PID namespace; even a reboot of
the same computer leaves earlier copies protected. Full worktrees also remain
protected because hooks, filters, and raw source require separate proof. Their
ordinary cleanup retains the remaining staging if exact Git registration removal
fails, including its receipt when registration was eligible. Repo-local copies
remain unmarked. There is no global worktree prune or force-recovery option.

Source-transfer commands inspect at most 64 bounded headers with a 250-ms soft
discovery budget. This scan does not hash payloads, search Git history, or query a
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
