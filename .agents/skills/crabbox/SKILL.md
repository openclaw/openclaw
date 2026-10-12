---
name: crabbox
description: "Crabbox and Blacksmith Testbox remote testing: isolation, cross-platform E2E, diagnostics, cleanup."
---

# Crabbox

Use only for exceptional proof under the [proof policy](../openclaw-testing/SKILL.md#proof-policy)
and only when a box is granted right away. If it queues, stop your queued
allocation and run locally; preserve the untrusted-code boundary and report
uncovered requirements. Never wait on queues or chain provider fallbacks.

Backends:

- `blacksmith-testbox`: trusted maintainer source. Prepared CI. `tbx_...`.
- `aws`: direct brokered Crabbox. Fresh PRs. Custom sync/env/capture. `cbx_...`.
- `local-container`: Docker fallback. Not remote proof.
- `ssh`: existing operator host. macOS/Windows/WSL2.

Always report provider, id, run URL, command, result. Never call Testbox “AWS
Crabbox.”

## Repository Contract

Resolve example commands, bootstrap, container image, and PR from trusted
consumer instructions; never invent commands or copy another consumer's setup.
Consumer-specific setup stays outside this portable skill. See
[placeholder definitions](references/operations.md#repository-contract).

## Authorization and Isolation

Task-needed creation, reuse, cleanup, temporary state, and clean checkouts are
pre-approved. Preserve existing branches, checkouts, and unrelated edits.
Source trust, credentials, production access, budget, and publication remain
authority boundaries. Use isolated state; never touch an operator Gateway
without per-task approval.

## Route First

- Preserve the resolved provider: Testbox for trusted source, direct AWS when
  its semantics are required, secretless CI/AWS for untrusted code. Never run
  untrusted wrappers/config locally or hydrate an untrusted lease.
- Acquire when the command is ready, reuse the owned ID, then stop.
- Use the smallest proven profile. Larger profiles need recorded memory evidence
  or measured total-cost benefit, not generic failure, delay, or timeout. Do not
  raise worker counts to compensate.
- Testbox sizing uses `--blacksmith-workflow`, not direct `--class`/`--type`;
  profile changes require fresh leases.
- Size, duration, hydration failure, and capacity do not authorize provider
  overrides; explicit user selection or required backend semantics do.

## Preflight

From the trusted repo root, read `.crabbox.yaml`, resolve the installed binary,
and inspect its provider and commands:

```sh
export CRABBOX="$(command -v crabbox)"
test -n "$CRABBOX"
"$CRABBOX" --version
"$CRABBOX" config show --json | jq '{provider, profile, target}'
"$CRABBOX" run --help
```

Use the consumer's trusted wrapper/install instructions. For repairs, verify
upstream and use a clean task-owned checkout; preserve the installed binary
and unrelated source. Never trust a sibling checkout merely by its name.

## Trusted Testbox

When the resolved provider is Testbox (or explicitly requested), these commands
preserve it. Add `--provider blacksmith-testbox` only for an explicit override:

```sh
"$CRABBOX" run --timing-json -- CI=1 <check-command>
```

Several commands: warm once, save id, reuse, stop.

```sh
"$CRABBOX" warmup --keep --timing-json
"$CRABBOX" run --id <tbx_id> --timing-json -- <check-command>
"$CRABBOX" stop <tbx_id>
```

Rules:

- One lease, one active command. No sync/reclaim during run.
- Prefer `bash -c`; login profiles can change directories. Assert physical
  checkout and expected source/patch in the executing shell; HEAD alone does
  not prove dirty sync. Follow a consumer's documented hydration shell contract.
- Native Testbox runs own sync, including reused `--id` runs. Never rely on
  `--no-sync` to preserve a remote baseline: Blacksmith has no native bypass,
  and released Crabbox versions can silently ignore the flag. An unchanged
  intentional rerun is not a Testbox exception.
- `--reclaim` only deliberate checkout-path ownership transfer.
- Base/head change: stop. Rewarm. No stale-lease override.
- Raw SHA unreliable for `warmup --ref`; use branch/tag.
- `blacksmith testbox list` hides states. Use `list --all` or
  `status --id <tbx_id>`.
- Testbox status/stop: `--id`. No status `--json`.
- Delegated provider rejects `--fresh-pr`, `--full-resync`, `--script*`,
  `--env-helper`, capture/download flags.

### Blacksmith directory downloads

For recursive downloads and the required remote trailing slash, read
[directory downloads](references/operations.md#blacksmith-directory-downloads).

## Untrusted AWS

Clean trusted default-branch checkout. Installed trusted Crabbox binary. Fresh
lease per reviewed full head SHA. No instance role. No Tailscale. No hydration.
Only `CI` forwarded. Trusted bootstrap uploaded beside `--fresh-pr`.

```sh
cd <clean-trusted-default-branch-checkout>
env -u CRABBOX_AWS_INSTANCE_PROFILE \
  "$CRABBOX" config show --json | \
  jq -e '.aws.instanceProfile == ""' >/dev/null

env -u CRABBOX_AWS_INSTANCE_PROFILE \
  -u CRABBOX_TAILSCALE \
  -u CRABBOX_TAILSCALE_AUTH_KEY \
  -u CRABBOX_TAILSCALE_AUTH_KEY_ENV \
  -u CRABBOX_TAILSCALE_EXIT_NODE \
  -u CRABBOX_TAILSCALE_EXIT_NODE_ALLOW_LAN_ACCESS \
  -u CRABBOX_TAILSCALE_HOSTNAME_TEMPLATE \
  -u CRABBOX_TAILSCALE_TAGS \
  "$CRABBOX" warmup \
  --provider aws --network public --tailscale=false \
  --tailscale-exit-node= \
  --tailscale-exit-node-allow-lan-access=false \
  --keep --timing-json

"$CRABBOX" inspect --provider aws --id <cbx_id> --json | \
  jq -e '.network == "public" and .tailscale == null' >/dev/null

env -u CRABBOX_AWS_INSTANCE_PROFILE \
  CRABBOX_ENV_ALLOW=CI \
  "$CRABBOX" run \
  --provider aws --id <cbx_id> \
  --fresh-pr <owner/repo#number> \
  --no-hydrate --timing-json \
  --script <trusted-bootstrap-script> -- \
  <expected_full_head_sha> <check-command>

env -u CRABBOX_AWS_INSTANCE_PROFILE \
  "$CRABBOX" stop --provider aws <cbx_id>
```

The trusted bootstrap must prove IMDSv2 IAM credentials return 404, verify SHA,
remove runtime injection variables, pin the toolchain, and isolate `HOME` before
install/test. Changed head needs a fresh lease. Missing remote PR or no-role
proof means secretless fork CI.

## Direct AWS

For trusted AWS commands, auth diagnostics, resync, or clean PR/container
runs, read [direct providers](references/operations.md#direct-aws). Preserve
`--no-hydrate` on container runs and report local-container proof as local.

## Observability

Read [capture and environment flags](references/operations.md#observability)
when collecting artifacts or injecting credentials. Exact key, one command;
never print secrets, write them in the repo, or put them in shell history.
No safe injection path means live auth is blocked, not fake-key proof.

## Real E2E

Exercise the requested user entry point with isolated consumer state, not just
remote unit tests. Read [E2E procedure](references/operations.md#real-e2e) for
install/provider/interactive proof and comparing revisions safely.

## Desktop / Cross-OS

Read [desktop and cross-OS commands](references/operations.md#desktop-and-cross-os)
for SSH targets, paid macOS preflight, WebVNC, and app handoff verification.

## Failure Triage

Identify wrapper, provider, hydration, sync, SSH, or command failure:

```sh
"$CRABBOX" doctor
"$CRABBOX" status --id <id>
"$CRABBOX" inspect --id <id> --json
"$CRABBOX" logs <run_id>
"$CRABBOX" results <run_id>
blacksmith testbox list --all
blacksmith testbox status --id <tbx_id>
```

Queued capacity: stop owned allocations and follow proof policy. No retry
storm or provider switching. Stale sync: `--debug --timing-json`, then
`--full-resync` once on direct providers. Read failed phase/JUnit before a
focused rerun. Diagnose a broken wrapper with the installed CLI on the same
provider; update through the consumer's trusted path. Stop only owned IDs;
`stop` takes no `--timing-json`.
