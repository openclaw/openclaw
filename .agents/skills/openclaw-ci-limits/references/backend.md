## Resolve the active backend

Read the configured `OPENCLAW_CI_RUNNER_BACKEND` and the affected job's actual
runner before applying provider-specific guidance. The
[runner routing guide](../../../../docs/ci/runners.md#boat-build-qualification)
owns Boat's rollout, physical labels, and hosted fallbacks. Boat uses the hybrid
logical plan; a logical Blacksmith label alone does not identify the actual VM.

The [owner rollout](https://github.com/openclaw/openclaw/pull/198149) admits only
the documented human source authors and starters on same-repository first
attempts. Boat's public-user allowlist is a separate provider check; allowing a
bot there does not admit bot-started ordinary CI through the workflow.
[Fork PRs use GitHub-hosted runners](https://github.com/openclaw/openclaw/pull/198140),
including first attempts without repository variables. Preserve their coverage.
The Blacksmith measurements in this skill apply when a job actually selects Blacksmith.

## Provider Outage Circuit Breaker

Use the repository variable only after confirming a provider outage or
unavailable runner capacity. Record the previous repository override and any
inherited organization setting before changing it. Do not set it merely for a
failing test that has already started.

```bash
gh variable set OPENCLAW_CI_RUNNER_BACKEND --repo openclaw/openclaw --body github
```

Where the override is available, degraded `ci.yml` jobs use the same hosted
labels and non-Blacksmith paths as manual dispatches and fork retries.
Blacksmith-only Docker and sticky steps stay off, dependency setup uses the
ordinary Actions pnpm-store cache, and Android's large build uses separate
low-memory Gradle processes. Standard 4-core hosted runners make builds and
test lanes slower. Those jobs consume GitHub-hosted concurrency instead of
provider registrations. Fork PRs already use hosted runners.

After recovery, restore the recorded setting at its original scope. For a
previous repository override of `boat`:

```bash
gh variable set OPENCLAW_CI_RUNNER_BACKEND --repo openclaw/openclaw --body boat
```

Delete the temporary repository override only if it was previously unset:

```bash
gh variable delete OPENCLAW_CI_RUNNER_BACKEND --repo openclaw/openclaw
```

Deletion exposes any inherited organization setting; with neither setting,
`ci.yml` defaults to Blacksmith. See the
[recovery procedure](../../../../docs/ci/runners.md#runner-backend-modes) for the full routing
contract.

Scheduled health detection and automatic flipping are a follow-up, not part of
the current circuit breaker.
