---
name: crabbox
description: "Crabbox and Blacksmith Testbox remote testing: isolation, cross-platform E2E, diagnostics, cleanup."
---

# Crabbox

- Deliberate remote proof: follow [proof policy](../openclaw-testing/SKILL.md#proof-policy).
  Prefer bounded local proof on a qualified, available host. Expensive or
  platform-specific work can use remote capacity. Queued: stop owned allocation;
  use PR CI or a safe local scope and report uncovered requirements.
- Never wait on queues or chain provider fallbacks.

Backends:

- `blacksmith-testbox`: trusted maintainer source. Prepared CI. `tbx_...`.
- `aws`: direct brokered Crabbox. Fresh PRs. Custom sync/env/capture. `cbx_...`.
- `local-container`: Docker fallback. Not remote proof.
- `ssh`: existing operator host. macOS/Windows/WSL2.

Always report provider, id, run URL, command, result. Never call Testbox “AWS
Crabbox.”

## Repository Contract

- Resolve example commands, bootstrap, container image, PR from trusted consumer
  instructions. Never invent commands or copy another consumer's setup.
- Consumer-specific setup stays outside portable skill. See
  [placeholder definitions](references/operations.md#repository-contract).

## Authorization and Isolation

- Task-needed creation, reuse, cleanup, temporary state, clean checkouts:
  pre-approved. Preserve existing branches, checkouts, unrelated edits.
- Source trust, credentials, production access, budget, publication remain
  authority boundaries. Isolated state; never touch operator Gateway without
  per-task approval.

## Route First

- Preserve resolved provider: Testbox for trusted source; direct AWS when its
  semantics required; secretless CI/AWS for untrusted code. Never run untrusted
  wrappers/config locally or hydrate untrusted lease.
- Acquire when command ready; reuse owned ID; stop afterward.
- Smallest proven profile. Larger: recorded memory evidence or measured
  total-cost benefit required, not generic failure/delay/timeout. Do not raise
  worker counts to compensate.
- Testbox sizing: `--blacksmith-workflow`, never direct `--class`/`--type`;
  profile changes require fresh leases.
- Blacksmith runner labels request a tier, not guaranteed CPU or RAM.
  Blacksmith can allocate smaller machines depending on service availability.
  For resource-sensitive tests or benchmarks, measure available CPUs,
  affinity/quotas, and usable RAM on the allocated machine. Size workers and
  workloads from those measurements. Record the requested tier and observed
  resources separately. Do not qualify hardware or performance from labels alone.
- Size, duration, hydration failure, capacity never authorize provider overrides;
  explicit user selection or required backend semantics do.

## Preflight

Trusted repo root: read `.crabbox.yaml`, resolve installed binary, inspect
provider/commands:

```sh
export CRABBOX="$(command -v crabbox)"
test -n "$CRABBOX"
"$CRABBOX" --version
"$CRABBOX" config show --json | jq '{provider, profile, target}'
"$CRABBOX" run --help
```

- Use consumer's trusted wrapper/install instructions.
- Repairs: verify upstream; use clean task-owned checkout; preserve installed
  binary + unrelated source. Never trust sibling checkout merely by name.

## Lease lifetime

- TTL counts from creation, including hydration; idle timeout counts inactivity.
  Earlier deadline wins. Defaults: 30m each, 4h maximum. Owner/org overrides can
  allow up to 24h; use effective policy and sanitized clamp notices, not requested
  durations. Policy tightening also applies to live leases.
- `--keep` and `stop: never` do not prevent expiry. Request explicit bounded TTL
  and idle for retained direct leases. Plain heartbeat, setup, sync, SSH, and
  desktop use do not extend total TTL; `run` requests bounded auto-extension only
  while a command executes, within policy, budget, and provider capability.
- Before long source-dependent work, inspect remaining total lifetime. If allowed,
  request one bounded `extend <id> --ttl <desired-total> --json`; extension does
  not reset idle. Denied/budget/unsupported/nonadvancing/inactive outcomes require
  a visible skip or failure, never provider switching or infinite lease chains.
  Creation-fixed providers such as Daytona need enough TTL at allocation.
- Direct guest-refresh failure can leave a longer provider deadline with the old
  on-box deadline. Keep the same local state and retry the same fixed total TTL
  only to reconcile; do not treat the failed extension as protection.
- Honor trusted `directLeases: deny` and `directLeaseAllow`. A denied provider
  requires the configured coordinator route; never bypass with direct credentials.
  Testbox retains its native job and idle limits;
  `--ttl` does not extend a delegated workflow.
- `list` shows live coordinator leases; `list --retained` adds kept terminal
  resources whose cleanup is unconfirmed. Use exact-ID inspect/stop for recovery.
  Retain claims and recovery state until a blocking stop confirms completion.

## Trusted Testbox

Resolved provider = Testbox (or explicitly requested): commands preserve it.
Add `--provider blacksmith-testbox` only for explicit override:

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
- Prefer `bash -c`; login profiles can change directories. In executing shell,
  assert physical checkout + expected source/patch; HEAD alone ≠ dirty-sync proof.
  Follow consumer's documented hydration shell contract.
- Native Testbox runs own sync, including reused `--id` runs. Never rely on
  `--no-sync` for remote baseline: Blacksmith has no native bypass; released
  Crabbox versions can silently ignore flag. Unchanged intentional rerun ≠ exception.
- `--reclaim` only for deliberate checkout-path ownership transfer.
- Follow the consumer's allocation receipt for reuse. Compatible source commits
  may reuse a lease when task, physical checkout, base, dependencies, preparation,
  and workflow/job/ref remain unchanged. Keep the original allocation provenance.
  Incompatible receipt: stop; rewarm. No stale-lease override.
- Raw SHA unreliable for `warmup --ref`; use branch/tag.
- `blacksmith testbox list` hides states. Use `list --all` or `status --id <tbx_id>`.
- Testbox status/stop: `--id`. No status `--json`.
- Delegated provider rejects `--fresh-pr`, `--full-resync`, `--script*`,
  `--env-helper`, capture/download flags.

### Blacksmith directory downloads

Recursive downloads + required remote trailing slash:
[directory downloads](references/operations.md#blacksmith-directory-downloads).

## Untrusted AWS

- Clean trusted default-branch checkout. Installed trusted Crabbox binary.
- Fresh lease per reviewed full head SHA. No instance role, Tailscale, hydration.
- Forward only `CI`. Upload trusted bootstrap beside `--fresh-pr`.

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
  --ttl 4h --idle-timeout 90m --keep --timing-json

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

- Trusted bootstrap must prove IMDSv2 IAM credentials return 404; verify SHA;
  remove runtime injection variables; pin toolchain; isolate `HOME` before
  install/test.
- Changed head: fresh lease. Missing remote PR or no-role proof: secretless fork CI.

## Direct AWS

- Trusted AWS commands, auth diagnostics, resync, clean PR/container runs: read
  [direct providers](references/operations.md#direct-aws).
- Preserve `--no-hydrate` on container runs; report local-container proof as local.

## Observability

- Collecting artifacts/injecting credentials: read
  [capture and environment flags](references/operations.md#observability).
- Exact key, one command. Never print secrets, write in repo, or put in shell history.
- No safe injection path: live auth blocked; fake-key proof insufficient.

## Real E2E

- Exercise requested user entry point with isolated consumer state, not just
  remote unit tests.
- For install/provider/interactive proof + safe revision comparison: read
  [E2E procedure](references/operations.md#real-e2e).

## Desktop / Cross-OS

SSH targets, paid macOS preflight, WebVNC, app handoff verification: read
[desktop and cross-OS commands](references/operations.md#desktop-and-cross-os).

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

- Queued capacity: stop owned allocations; follow proof policy. No retry storm
  or provider switching.
- Stale sync: `--debug --timing-json`, then `--full-resync` once on direct providers.
- Read failed phase/JUnit before focused rerun. Broken wrapper: diagnose with
  installed CLI on same provider; update through consumer's trusted path.
- Stop only owned IDs; `stop` takes no `--timing-json`.
