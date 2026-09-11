---
summary: "Package Acceptance jobs, candidate sources, suite profiles, and dispatch examples"
read_when:
  - You are validating an installable OpenClaw package
  - You are debugging a failed package acceptance run
title: "Package Acceptance"
sidebarTitle: "Package Acceptance"
---

Package Acceptance jobs, candidate sources, suite profiles, compatibility windows, and dispatch examples. Part of the [Release validation workflows](/ci/release-validation) index.

## Package Acceptance

Use `Package Acceptance` when the question is "does this installable OpenClaw package work as a product?" It is different from normal CI: normal CI validates the source tree, while package acceptance validates a single tarball through the same Docker E2E harness users exercise after install or update.

### Jobs

1. `resolve_package` checks out `workflow_ref`, resolves one package candidate, writes `.artifacts/docker-e2e-package/openclaw-current.tgz`, writes `.artifacts/docker-e2e-package/package-candidate.json`, uploads both as the `package-under-test` artifact, and prints the source, workflow ref, package ref, version, SHA-256, and profile in the GitHub step summary.
2. `package_integrity` downloads the `package-under-test` artifact and enforces the public package tarball contract with `scripts/check-openclaw-package-tarball.mjs`.
3. `npm_12_install_sh` installs that exact artifact through the public Linux installer under npm 12 in an isolated home/prefix, then verifies the CLI version and lifecycle-completion guard.
4. `docker_acceptance` calls `openclaw-live-and-e2e-checks-reusable.yml` with the resolved package source SHA (falling back to `workflow_ref`) and `package_artifact_name=package-under-test`. The reusable workflow downloads that artifact, validates the tarball inventory, prepares package-digest Docker images when needed, and runs the selected Docker lanes against that package instead of packing the workflow checkout. When a profile selects multiple targeted `docker_lanes`, the reusable workflow prepares the package and shared images once, then fans those lanes out as parallel targeted Docker jobs with unique artifacts.
5. `package_telegram` optionally calls `NPM Telegram Beta E2E`. It runs when `telegram_mode` is not `none` and installs the same `package-under-test` artifact when Package Acceptance resolved one; standalone Telegram dispatch can still install a published npm spec.
6. `summary` fails the workflow if package resolution, integrity, npm 12 installer acceptance, Docker acceptance, or the optional Telegram lane failed. The `advisory` input downgrades acceptance failures to warnings for advisory callers.

### Candidate sources

- `source=npm` accepts only `openclaw@extended-stable`, `openclaw@beta`, `openclaw@latest`, or an exact OpenClaw release version such as `openclaw@2026.4.27-beta.2`. Use this for published extended-stable, prerelease, or stable acceptance.
- `source=ref` packs a trusted `package_ref` branch, tag, or full commit SHA. The resolver fetches OpenClaw branches/tags, verifies the selected commit is reachable from repository branch history or a release tag, installs deps in a detached worktree, and packs it with `scripts/package-openclaw-for-docker.mjs`.
- `source=url` downloads a public HTTPS `.tgz`; `package_sha256` is required. This path rejects URL credentials, non-default HTTPS ports, private/internal/special-use hostnames or resolved IPs, and redirects outside the same public safety policy.
- `source=trusted-url` downloads an HTTPS `.tgz` from a named trusted-source policy in `.github/package-trusted-sources.json`; `package_sha256` and `trusted_source_id` are required. Use this only for maintainer-owned enterprise mirrors or private package repositories that need configured hosts, ports, path prefixes, redirect hosts, or private-network resolution. If the policy declares bearer auth, the workflow uses the fixed `OPENCLAW_TRUSTED_PACKAGE_TOKEN` secret; URL-embedded credentials are still rejected.
- `source=artifact` downloads one `.tgz` from `artifact_run_id` and `artifact_name`; `package_sha256` is optional but should be supplied for externally shared artifacts.

Keep `workflow_ref` and `package_ref` separate. `workflow_ref` is the trusted workflow/harness code that runs the test. `package_ref` is the source commit that gets packed when `source=ref`. This lets the current test harness validate older trusted source commits without running old workflow logic.

### Suite profiles

- `smoke` — `npm-onboard-channel-agent`, `gateway-network`, `config-reload`
- `package` — `npm-onboard-channel-agent`, `doctor-switch`, `update-channel-switch`, `skill-install`, `update-corrupt-plugin`, `upgrade-survivor`, `published-upgrade-survivor`, `root-managed-vps-upgrade`, `update-restart-auth`, `plugins-offline`, `plugin-update`
- `product` — the `package` set with live `plugins` coverage instead of `plugins-offline`, plus `mcp-channels`, `cron-mcp-cleanup`, `openai-web-search-minimal`, `openwebui`
- `full` — full Docker release-path chunks with OpenWebUI
- `custom` — exact `docker_lanes`; required when `suite_profile=custom`

The `package` profile uses offline plugin coverage so published-package validation is not gated on live ClawHub availability. The optional Telegram lane reuses the `package-under-test` artifact in `NPM Telegram Beta E2E`, with the published npm spec path kept for standalone dispatches.

For the dedicated update and plugin testing policy, including local commands,
Docker lanes, Package Acceptance inputs, release defaults, and failure triage,
see [Testing updates and plugins](/help/testing-updates-plugins).

Release checks call Package Acceptance with `source=artifact`, the prepared release package artifact, `suite_profile=custom`, `docker_lanes='doctor-switch update-channel-switch skill-install update-corrupt-plugin upgrade-survivor published-upgrade-survivor root-managed-vps-upgrade update-restart-auth plugins-offline plugin-update plugin-binding-command-escape'`, and `telegram_mode=mock-openai`. This keeps package migration, update, live ClawHub skill install, stale-plugin-dependency cleanup, configured-plugin install repair, offline plugin, plugin-update, and Telegram proof on the same resolved package tarball. Set `release_package_spec` on Full Release Validation or OpenClaw Release Checks after publishing a beta to run the same matrix against the shipped npm package without rebuilding; set `package_acceptance_package_spec` only when Package Acceptance needs a different package from the rest of release validation. Cross-OS release checks still cover OS-specific onboarding, installer, and platform behavior; package/update product validation should start with Package Acceptance.

Upgrade-survivor assertion ownership follows the selected target's release train,
read from its immutable package metadata after source-identity validation.
Extended-stable targets retain their shipped scenario runner, assertions, and
fixtures; regular targets keep the trusted scenario together, including its
serving-turn/post-inference assertions.
The historical baseline does not select the assertion owner. Invalid target
versions and unsupported extended-stable correction versions fail before Docker.

Docker seed CI resolves an exact published stable predecessor of the selected source package version before running `published-upgrade-survivor`. It uses the release baseline resolver and selected release context, so publishing `latest` never turns the first upgrade into an already-current operation. Missing predecessors fail before Docker starts; the separate already-current control remains unchanged.

The `published-upgrade-survivor` Docker lane validates one published package baseline per scenario. In Package Acceptance, the resolved `package-under-test` tarball is always the candidate and `published_upgrade_survivor_baseline` selects the fallback published baseline, defaulting to `openclaw@latest`; failed-lane rerun commands preserve that baseline. Current source release checks set `published_upgrade_survivor_baselines=supported-lines` for `legacy-operator-state`: npm's current `latest`, the preceding stable version, `extended-stable` when that tag exists, and the documented oldest supported baseline `2026.6.34`. The resolver reads `npm view openclaw versions` and `npm view openclaw dist-tags` at run time, pins exact versions before fanout, and deduplicates overlapping lines. Normal current-source release checks retain `base` and add `legacy-operator-state`; release soak selects `reported-issues`, including legacy operator state and the existing issue-shaped fixtures.

Expanded release qualification requires the candidate's `YYYY.M.PATCH` base version
to be at least the trusted workflow package's base version, ignoring prerelease
suffixes for this comparison. It then reads immutable source-directory metadata for
the operator-state harness. Older source targets and extended-stable contexts
or branches keep the validated candidate-relative predecessor. Published candidates retain that predecessor and the preexisting synthetic
scenario inventory because their qualification path does not prepare the
registry required by the operator-state fixture.
A separate `package_acceptance_package_spec` override resolves its predecessor
from the override's actual package version inside Package Acceptance.

The child workflow prepares or reuses the prerelease plugin registry required
by the new scenario's artifact assertions, so that scenario runs only for
qualifying unpublished candidates. Published requalification retains `base`, or every preexisting
reported-issue scenario for soak, because its package path does not prepare
that registry. Historical qualification likewise excludes only the newly added
operator-state scenario. Existing frozen-target compatibility checks and the
explicit scenario-omission opt-in remain unchanged; candidate source code is
never executed to choose this profile.

For the standalone `supported-lines` selector, the group planner runs every
preexisting synthetic scenario only against that separately resolved
predecessor, and runs `legacy-operator-state` against each supported baseline.
It merges overlapping groups and retains every requested fixture; a missing
or moving-tag predecessor fails planning. Comma and whitespace delimiters and
repeated standalone selectors use the resolver's normal token grammar. Explicit version lists and mixed selector/version lists retain the
full Cartesian baseline/scenario matrix for deliberate manual proof. The
selector provenance travels only as internal reusable-workflow metadata;
there is no new manual-dispatch input.

Expanded published-upgrade survivor and update-migration selections are split by baseline into groups of at most three scenarios, with at most 32 targeted Docker jobs active per matrix. Grouping shares the execution planner's baseline-compatibility policy, so every supported scenario runs exactly once without creating empty shards for old baselines. Each scenario owns a fresh container and the unchanged npm resource limit; package and image identities remain shared across the matrix. `Update Migration` runs weekly on Sunday at 03:17 UTC and on manual dispatch. It defaults to `supported-lines` with both `plugin-deps-cleanup` and `legacy-operator-state`, keeps the existing cleanup coverage, and forwards no provider secrets. The weekly run keeps cleanup on the candidate-relative predecessor and exercises native operator state on each supported baseline. A planning allowance of 12 minutes per scenario plus 30 minutes for shared package/image preparation and controls gives about 78 runner-minutes weekly with three distinct baselines, or 90 with four; actual timing artifacts determine the observed cost.

Pass `baselines=all-since-2026.4.23` for exhaustive historical cleanup; `last-stable-4`, `release-history`, and exact historical versions remain explicit manual selections. Local aggregate runs can pass the resolved exact specs through `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS`, keep a single lane with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC`, or set `OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS` for the scenario matrix. Existing scenarios retain their baked `openclaw config set` recipes and summary records. The new operator-state scenario instead uses the baseline's own agent, exec-approvals, cron, and plugin CLIs, then verifies preserved state and a mock-provider turn after upgrade. Gateway probes include `/healthz`, `/readyz`, and RPC status. See [Testing updates and plugins](/help/testing-updates-plugins) for the preserved-state and successful-upgrade requirements.

All supported baseline rows require successful updates. Existing synthetic
`base` and reported-issue fixtures retain their success assertions and run once
on the candidate-relative predecessor. The lane does not run an extra Doctor or
omit those fixtures to turn a failed schema upgrade into a pass.

The Windows packaged and installer fresh lanes also verify that an installed package can import a browser-control override from a raw absolute Windows path. The OpenAI cross-OS agent-turn smoke defaults to `OPENCLAW_CROSS_OS_OPENAI_MODEL` when set, otherwise `openai/gpt-5.6-luna`, so the install and gateway proof uses the lower-cost GPT-5.6 test tier.

### Legacy compatibility windows

Package Acceptance has bounded legacy-compatibility windows for already-published packages. Packages through `2026.4.25`, including `2026.4.25-beta.*`, may use the compatibility path:

- known private QA entries in `dist/postinstall-inventory.json` may point at tarball-omitted files;
- `doctor-switch` may skip the `gateway install --wrapper` persistence subcase when the package does not expose that flag;
- `update-channel-switch` may prune missing pnpm `patchedDependencies` from the tarball-derived fake git fixture and may log missing persisted `update.channel`;
- plugin smokes may read legacy install-record locations or accept missing marketplace install-record persistence;
- `plugin-update` may allow config metadata migration while still requiring the install record and no-reinstall behavior to stay unchanged.

The published `2026.4.26` package may also warn for local build metadata stamp files that were already shipped. Current package validators require both npm lockfile formats to be absent from new tarballs.

### Examples

```bash
# Validate the current beta package with product-level coverage.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=npm \
  -f package_spec=openclaw@beta \
  -f suite_profile=product \
  -f telegram_mode=mock-openai

# Validate the published extended-stable package with package coverage.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=npm \
  -f package_spec=openclaw@extended-stable \
  -f suite_profile=package \
  -f telegram_mode=mock-openai

# Pack and validate a release branch with the current harness.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=ref \
  -f package_ref=release/YYYY.M.PATCH \
  -f suite_profile=package \
  -f telegram_mode=mock-openai

# Validate a tarball URL. SHA-256 is mandatory for source=url.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=url \
  -f package_url=https://example.com/openclaw-current.tgz \
  -f package_sha256=<64-char-sha256> \
  -f suite_profile=smoke

# Validate a tarball from a named trusted private mirror policy.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=trusted-url \
  -f trusted_source_id=enterprise-artifactory \
  -f package_url=https://packages.example.internal:8443/artifactory/openclaw/openclaw-current.tgz \
  -f package_sha256=<64-char-sha256> \
  -f suite_profile=smoke

# Reuse a tarball uploaded by another Actions run.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=artifact \
  -f artifact_run_id=<run-id> \
  -f artifact_name=package-under-test \
  -f suite_profile=custom \
  -f docker_lanes='install-e2e plugin-update'
```

When debugging a failed package acceptance run, start at the `resolve_package` summary to confirm the package source, version, and SHA-256. Then inspect the `docker_acceptance` child run and its Docker artifacts: `.artifacts/docker-tests/**/summary.json`, `failures.json`, lane logs, phase timings, and rerun commands. Prefer rerunning the failed package profile or exact Docker lanes instead of rerunning full release validation.
