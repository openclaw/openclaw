# Interim deployment controller

This is the deployment controller bundled with the repository's
[update-team-server skill](../SKILL.md). It preserves the existing managed-release
owner while native `openclaw update` gains and proves the remaining migration,
recovery, acceptance, and adoption contracts. It is not another scheduler or an
alternative public update CLI. Do not add it to runtime packages or default
Vitest projects.

The source is Manager commit
`d02035d40a9a2a9d73afee700aec26a10d1c66a9`, directory
`ops/openclaw/team-hourly-update/`. The imported controller includes its existing
agent-schema 24→25 admission; this move adds no schema edge or storage migration.
Native replacement must settle outstanding controller transactions before
retiring their recovery code. See the
[immutable update design](https://docs.openclaw.ai/reference/team-immutable-update-design).

## Installed closure

Install from one reviewed, merged OpenClaw commit. These four files are one
versioned closure; a new deploy script with an old library is not supported.
All installed files and their parent directories are owned by `root:root`, with
no group or other write access. Libraries use mode `0644`; the executable uses
`0755`; parent directories use `0755`.

| File                              | Installed path                                                 | Responsibility                                                              |
| --------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `openclaw-release-deploy`         | `/usr/local/sbin/openclaw-release-deploy`                      | Deployment, recovery, and maintenance orchestration under the existing lock |
| `release-lib.mjs`                 | `/usr/local/lib/openclaw-team/release-lib.mjs`                 | Admission, journal, backup, migration, and acceptance contracts             |
| `gateway-suspension-contract.mjs` | `/usr/local/lib/openclaw-team/gateway-suspension-contract.mjs` | Self-contained pinned suspension protocol validator                         |
| `startup-profile.mjs`             | `/usr/local/lib/openclaw-team/startup-profile.mjs`             | Controller-owned startup capture lifecycle                                  |

The suspension bundle is unchanged and its SHA-256 is pinned by the library.
The library imports the startup profiler beside itself. Candidate config repair
modules and SQLite extensions come from the sealed candidate release, not this
directory. Existing host maintenance commands remain separate owners.

Install [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) alongside the libraries
as `root:root`, mode `0644`: the unchanged suspension bundle includes TypeBox
1.3.34 under its MIT license. The notice is distribution metadata, not another
runtime module.

The effective existing updater service must execute
`/usr/local/sbin/openclaw-release-deploy` as root. The historical
`openclaw-hourly-update.release.conf` clears `ExecStart` and selects this command;
it is an existing operator-owned service input, not a new installer. Preserve
all current service limits, environment, locks, and drop-ins. Do not install the
old mutable wrapper, enable the historical timer, or invent a second cadence.

## Private operator configuration

Supply `OPENCLAW_TEAM_OPERATOR_PROFILE` as JSON in the updater's private,
root-controlled environment. Keep its source file `root:root`, mode `0600`,
outside the source checkout. Reuse the same value for every controller and
library invocation, including recovery and manual read-only diagnostics.
Do not derive expected values from the candidate: they express the operator's
previously approved acceptance policy. Missing or malformed required values
fail verification.

The object has these fields:

- `channels`: a nonempty array of distinct `[pluginId, accountId]` pairs that
  must each be exactly ready.
- `modelAgent`: the configured agent whose model is checked and whose isolated,
  non-delivering acceptance marker runs. The existing default-model fallback
  remains unchanged.
- `policy`: expected `mode`, `workspaceOnly`, `updateAuto`,
  `clickclackCommandMenu`, and `appServer`. The latter contains `mode`,
  `approvalPolicy`, `approvalsReviewer`, `sandbox`, and `defaultWorkspaceDir`.
  Other actual app-server fields remain in the captured policy, preserving
  subsequent drift detection. `updateAuto` must remain `false`. The complete
  profile is checked during the pre-cutover policy check, including channels.
- `handoff`: only required for the existing host-handoff config verification;
  contains `provider`, `sourceBaseUrl`, and `targetBaseUrl`. Verification still
  allows only the approved endpoint change, worktree-root relocation, and
  native metadata normalization.

`test-environment.mjs` is a synthetic test profile, **not a deployment default**.
Night Watch must transcribe the incumbent's approved private values and compare
its policy/channel/handoff results before adopting this closure. Protect and
bind the profile together with the code; changing it changes acceptance policy
and requires its own operator authorization.

Privacy changes are limited to replacing hard-coded deployment expectations
with this profile, generic error wording, removal of private campaign labels,
and synthetic test identities/endpoints/models. The deploy script's marker
uses `modelAgent` for both dispatch and acknowledgement checks. With the
incumbent values configured, these comparisons and marker addressing are the
same as the source. No private endpoint, coordinator session ID, credentials,
operator notes, or host inventory belongs in this public directory.

Independent import review also identified existing runtime defects repaired
here: stopped-owner checks now reuse the native stopped-manager proof when the
retired user bus is absent; source export distinguishes PID reuse from the
original Gateway generation while still checking database writers; and optional
profile closure compares activation hashes from the same phase. Pointer
publication propagates failures before another lifecycle step; workspace
containment is checked before creating rehearsal directories; and history
verification checks captured transcript generations even when a logical session
key survives. Migration rollback arms the native handoff before stopping a
draining successor, and switching recovery verifies the restored predecessor
before retiring its journal. Stopped-current recovery waits for a restored
persistent timer's catch-up invocation before applying its final snapshot checks.
The profile inspection change is transient; persisted arm records keep their existing shape.
Tests cover these repairs and use one prepared lease expiry in custody fixtures.

The controller delegates retired Workshop proposal preservation to native Doctor.
Doctor owns draft export and recovery warnings before dropping the retired tables;
the controller must not require those rows to remain in SQLite. Its original
lossless backups, physical database ownership checks, and session witnesses still
apply. See the [state schema history](../../../../docs/reference/database-schemas/state-schema-history.md#skill-workshop-proposal-retirement-state-schema-20-same-version)
for the retirement contract.

## Complete-pair adoption

Release publication now prewarms Node's release-scoped compile cache before
cutover, including reuse of an already published release. The bounded import
runs as `openclaw`, with the selected Gateway runtime, after publication at its
final path. It loads the Gateway graph without starting a server or reading
Gateway state; the existing cache owner chooses the build-ID namespace and
retention policy. Missing prewarm entries in older releases are skipped, and
prewarm failures warn and leave ordinary cold startup available. Bun does not
use Node's compile cache. Night Watch must adopt this reviewed controller
change through the complete-pair procedure below; landing it does not change
the installed controller or authorize a Team deployment.

Only the designated Night Watch executor performs these steps. Resolve its
exact host and coordinator session from the private operator record, preserve
per-deployment approval, and coordinate any intentional restart there. A code
publication is not a deployment or a request to restart the Gateway.

1. Stage the four files from one merged OpenClaw commit, verify their reviewed
   hashes, and run `bash -n` on the executable and `node --check` on the modules.
   Prepare the private profile from incumbent expectations. Never stage Manager
   source, notes, or an operations repository on the deployment host.
2. Through the current owner, settle all old controller readers, including
   manual and pre-lock invocations. Require the updater service's `MainPID` and
   `ControlPID` to be zero, no queued job, and no unresolved activation journal.
   Bind the installed closure/profile identities and hashes, Gateway
   PID/start/invocation, release pointers, config/database identities, loaded
   startup guard/permit, and disabled deployment schedule.
3. Acquire the existing deployment lock on file descriptor 9 without replacing
   its inode. Recheck the bound facts under that lock. An unresolved transaction
   needs its existing recovery closure and a separately reviewed exact-phase
   procedure; never clear its journal to make installation possible.
4. Preserve exact predecessor bytes, ownership, modes, and profile in a private
   recovery directory and fsync it. Stage replacement files alongside their
   destinations with the modes above; fsync files and parent directories.
   Recheck admission, then rename the complete pair and matching changed helpers
   while all readers remain excluded. Multiple renames are not an atomic pair:
   on interruption, keep exclusion and reconcile every file before allowing
   any reader. Restore only through that same bound recovery procedure.
5. Verify all four installed hashes, ownership/modes, profile, syntax, and the
   unchanged runtime bindings before unlocking. Retain predecessor recovery
   artifacts while referenced. Report publication to Night Watch's coordinator;
   actual deployment and native acceptance remain a separate approved action.

## Standalone tests

Use disposable Linux with Node 24.16+ or 26.1+, Bun 1.4+, Bash, Python 3, GNU
coreutils, `flock`, and `/usr/bin/bwrap`. Full coverage requires root and working user/mount
namespaces. Tests use synthetic temporary state, services, processes, and
Gateways; they do not contact Team. Some boundary tests extract Bash functions;
owner-flow tests execute the real deploy entrypoint with external service stubs.
This suite does not prove a live systemd cutover or production acceptance.

The runtime deliberately pins the suspension bundle's installed path. Runtime
tests require actual root-owned Node and Bun binaries under root-owned,
non-writable ancestors; symlinks into a user's toolcache do not qualify. Provide
them at `/usr/bin/node` and `/usr/local/bin/bun` on the disposable host. Copy the
test closure with matching ownership. Run offline Doctor as an ordinary user,
because its fixtures model unprivileged state ownership; the other files run as
root for their explicitly privileged cases:

```sh
controller=.agents/skills/update-team-server/controller
sudo install -d -o root -g root -m 0755 /usr/local/lib/openclaw-team /opt/openclaw-controller-test
sudo cp -R "$controller/." /opt/openclaw-controller-test/
sudo chown -R root:root /opt/openclaw-controller-test
sudo chmod -R a+rX /opt/openclaw-controller-test
sudo install -o root -g root -m 0644 "$controller/gateway-suspension-contract.mjs" \
  /usr/local/lib/openclaw-team/gateway-suspension-contract.mjs
sudo install -d -o root -g root -m 0755 /var/tmp/openclaw-controller-root
mkdir -p /var/tmp/openclaw-controller-user
cd /opt/openclaw-controller-test
root_tests=()
for file in *.test.mjs; do
  [[ "$file" == offline-doctor.test.mjs ]] || root_tests+=("$file")
done
sudo env TMPDIR=/var/tmp/openclaw-controller-root /usr/bin/node \
  --import ./test-environment.mjs --test "${root_tests[@]}"
TMPDIR=/var/tmp/openclaw-controller-user /usr/bin/node \
  --import ./test-environment.mjs --test offline-doctor.test.mjs
```

Use disk-backed temporary storage with at least 18 GiB free. A smaller `/tmp`
tmpfs correctly fails the controller's production headroom checks before these
fixtures reach their intended boundaries.

Inspect failed **and skipped** counts. Non-root or unavailable bubblewrap skips
are coverage gaps, not full success. Run the repository changed-file gate and
closure guards on the same candidate as well. The Node suite stays opt-in;
there is no new default CI/Vitest workload.

## Deliberately omitted

The mutable `openclaw-hourly-update`, `openclaw-release-cutover`, old service and
timer templates, and Manager installer/inventory/runbook test are not loaded by
this closure. Existing host service configuration stays with the operator.
The two `team-metal-*.py` tools are one-off transaction glue. The historical
`suspension-contract-provenance/` toolchain, manifests, and legacy pair are not
runtime inputs; the validated generated bundle is retained byte-for-byte.

`update.test.mjs` becomes `release.test.mjs` after removing only its retired
mutable-updater fixture and cases. `suspension-custody.test.mjs` retains current
custody/tamper coverage and omits the two historical mixed-pair cases that need
the excluded legacy snapshot. Other controller tests and their four support
fixtures remain. New profile tests cover the publication substitutions.
The lease and handoff fixtures retain their assertions while updating their
canonical database layout, command responses, and independent capacity inputs.

## Source SHA-256

The reviewed `release-lib.mjs` in this tree has SHA-256
`53bd61bcaccd34cd1f0f21c5a0b998682bd5a700d99038e3a3b873a0e40eea96`.
Verify that hash against the exact merged tree before adoption. This replaces
the obsolete Workshop row-preservation check; the original import hash below
remains provenance for the Manager source, not the installable library.

These are the original Manager bytes, before the documented privacy edits,
review repairs, and test extraction. `release.test.mjs` maps to original
`update.test.mjs`. Newly written README, test profile, and regression files have no
imported source hash. The third-party notice comes from TypeBox 1.3.34's license.
For installation, hash the exact **merged** files; the source hashes below are
provenance, not replacement-file approval.

| Imported file                            | Original SHA-256                                                   |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `abandon-rehearsal.test.mjs`             | `74572231b90b140fe96bf99f4bfb164e2a06f310781b1d76b456c69fade046d6` |
| `admission-rpc-diagnostics.test.mjs`     | `8efc59afde9f305f42b3d7a129086ffd44ee8a532accf5c5fc3e0026f5a8e858` |
| `agent20-cold-schema.fixture.sql`        | `6ce179fcc05ccc5cef34f82ec36d117b7de9c05b35ca8760e9cb5cc447e16431` |
| `drain-deadline.test.mjs`                | `eaff1e9d1b7944737d2088119a3443d629ba2454382725c155000e03147c4dea` |
| `frozen-continuation.test.mjs`           | `0b079810d5c4ad4b900915d7794bb713bab27a8bc5826fb523c86bb28ed755be` |
| `gateway-suspension-contract.mjs`        | `dfdf7487710647a5ea5a7ae4f2edb06812b2b251cb2ec4880d791ad650a5e456` |
| `host-handoff.test.mjs`                  | `183188b5246bedd78105d1ff9e74abf523519c968a83fc33783dda1fc31b24a5` |
| `maintenance-budget.test.mjs`            | `ab0902cf5d973c55352dd7ba5c218b14bdf923202a18f234c9027eed8c26af07` |
| `marker-deadline.test.mjs`               | `dfaee3fe08e4ea46c9b49105fe1c66c6e1533a90e299fe214f9707e4b1cecd5d` |
| `migration-admission.test.mjs`           | `07056b17f6984c6b931faa7ae9a9dc5871ea1794ae32a964896a727eb36f0eca` |
| `migration-forward-recovery.test.mjs`    | `68909a6ec391cab3f4cacaa3ecc196d9853e836f7bc474bdccb877c8985b32fb` |
| `migration-handoff-owner.test.mjs`       | `1bb8e0774fbc2d11ac99bf7f8313baaf9a1c9a8d17e3bb8ed3c5e47f5f3e6320` |
| `migration-lease-clock.test-support.mjs` | `358b33c60f3b58a746d903f04a79e222f19673c5f2f58fb65d859cf50bbfc27b` |
| `migration-lease-owner.test.mjs`         | `fb57d590a938c5a1c2b4540a230ad77a12b75e4bd79560fddbb7660ccd465ff2` |
| `mirror-budget.test.mjs`                 | `7dd013ff8bc4996a90a4f747380d4aeec2d4bdb9e5b36ee5547d3ee47055cf2b` |
| `offline-doctor.test.mjs`                | `20e6d10c04633594109cfa00a97844b76bcc72a4aa327c818e286dad97e67633` |
| `openclaw-release-deploy`                | `fd5879efa3d440f03e5c2ffdbc49b3fd855b8b9e5da5c1aa29c58b6de98fd056` |
| `prepare-release.test.mjs`               | `80373ab23f580a3b1835af475855f70f42defb46d0a7b544c239a499fcd1357e` |
| `reconciliation-terminal-fence.test.mjs` | `336ae6020e229ae469323c85590235f80335baca773925d104c55124051e58f0` |
| `rehearsal-journal-mode.test.mjs`        | `f52a4c8a6c0eb79868f702597d35d27af3dec65588ce5bcee642c70d85b45a92` |
| `rehearsal-outcome.test.mjs`             | `b9238fc89942974a8beb3b504594663f7ffec25f8676d1b79738fb44e103fe11` |
| `rehearsal-snapshot.test-support.mjs`    | `6af1a32bd98c5956e74619364f79bb4762dfa631550f17ce5cf0547bddcfc6e6` |
| `rehearsal-snapshot.test.mjs`            | `631cbc7b5b10fc3c4d6c725a42709cb8fa2d15c396079c29e20ff34e85589d24` |
| `release-lib.mjs`                        | `d1de214a652259995c86ca030aff7f2bc304beaa06c0547b2a8b03d3e3b881e6` |
| `runtime-switch.test.mjs`                | `e8fc5465d2e842aff73ff044df9eeb14514bc9b139594e5f78bf7c88b7dd4f79` |
| `startup-profile.mjs`                    | `329ed7455f00c92bc6d54ea475606b5f4c15a871f2205f3ea213189c8abff1c9` |
| `stopped-current-recovery.test.mjs`      | `138684ebf26c28c0e100a3ec654bfcca3da644f9df5ceca94e4fcc656756a849` |
| `stopped-restored-recovery.test.mjs`     | `014bb15afee2e3ab5cdb6adbfc2185d7ad8f381a977f07771fca21c2b81a460f` |
| `suspension-custody.test.mjs`            | `b6bcf83330906e1b3c3e32c8756af2b0bca0e840cae29d1e438b322b44c9792e` |
| `terminal-persistence-waiver.test.mjs`   | `05ed889573e7fc09eb9a0caeca76b5d4216ae8461b7ed7aa4f23e20fd0d8dbcf` |
| `release.test.mjs`                       | `b873e32bfbd4667cae71821cf9136a210cb84c805ce175598d8fbd88a0343ff8` |
| `user-ownership.test.mjs`                | `06d26a68e0c4d58163b67e2491248fdb91b700633e8f29a23b7f45bd742745c5` |
| `worker-config-owner-fixture.mjs`        | `c9e90908ebdf463814140ce71149b7f26279459f50ad0aab6c0fe4ddf3c1caad` |
| `worker-config-owner.test.mjs`           | `51b1fb7c24a32e51b41b2196f9f294d9b2b80d4cf681109c5c567c44a2031aa0` |
| `worker-config.test.mjs`                 | `f8c4eabb4d62d577106f7d70653a15cae7a3d3b9760c9fdb4730b026294cb781` |
