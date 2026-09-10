---
summary: "Manual CI dispatch behavior, release-gate fallbacks, and the Windows Testbox Probe"
read_when:
  - You are dispatching CI or Full Release Validation by hand
  - You need the Windows Testbox Probe inputs
title: "Manual dispatches"
sidebarTitle: "Manual dispatches"
---

Manual CI dispatch behavior, release-gate fallbacks, and the Windows Testbox Probe. Part of the [CI scope and routing](/ci/scope-and-routing) index.

## Manual dispatches

Ordinary manual CI dispatches run the same job graph as normal CI but force every non-Android scoped lane on: Linux Node shards, bundled-plugin shards, plugin and channel contract shards, Node 24 minimum compatibility, `check-*`, `check-additional-*`, built-artifact smoke checks, docs checks, Python skills, Windows, macOS, full iOS build/test and screenshot qualification, and Control UI/native app i18n. Their logical runner profile is always `github`, independent of the physical fallback selected by `runs-on`. Node 24 minimum compatibility runs in Full Release Validation and manual dispatches only; push and pull request CI skip it. The exact-head `release_gate` fallback instead keeps the pull request's macOS, iOS smoke, and generated-native-locale scope without selecting iOS screenshots or native tests. Automatic source PRs and release gates verify native extraction inventory and Android/Apple localization safety without requiring translated or platform-generated output in the same PR. The serialized Native App Locale Refresh workflow rebuilds those artifacts in one isolated PR and enables exact-head auto-merge after required checks pass. Full native parity remains blocking for generated-artifact PRs, generated-scope release gates, ordinary manual CI, full-scope release validation, and release prep. Control UI locale parity remains advisory on automatic PR and `main` runs and blocking on manual/release CI. Standalone manual CI dispatches run Android only with `include_android=true` (the `release_gate` input also forces Android); full-scope release validation enables Android by passing `include_android=true` without setting `release_gate`; npm qualification scopes defer Android. Plugin prerelease static checks, the full `agentic-plugins` sweep, the full extension batch sweep, and plugin prerelease Docker lanes are excluded from CI. The Docker prerelease suite runs only when `Full Release Validation` dispatches the separate `Plugin Prerelease` workflow with the release-validation gate enabled.

PR baseline ratchets derive their comparison state from the checked-out synthetic merge tree and verify its head parent against the event head. The max-lines entry chains the environment-variable budget with the same fork-point ref before the assertion-safety check, so production source growth cannot first surface on `main`. Manual runs use a unique concurrency group so a release-candidate full suite is not cancelled by another push or PR run on the same ref. The optional `target_ref` input lets a trusted caller run that graph against a branch, tag, or full commit SHA while using the workflow file from the selected dispatch ref; ratchet baselines are compared with the target's merge base against the default-branch head resolved for that run. The `release_gate` input is an exact-SHA maintainer fallback for capacity-stalled PR CI: it requires `target_ref` to be a full commit SHA that matches the dispatched branch head and `pull_request_number` to identify the open PR whose merge tree is validated. Release-gate merge-tree lint uses the same five core stripes as hosted PR CI plus one extension stripe, so no single hosted runner owns the full type-aware lint workload.

```bash
gh workflow run ci.yml --ref release/YYYY.M.PATCH
gh workflow run ci.yml --ref main -f target_ref=<branch-or-sha> -f include_android=true
VALIDATION_SHA="<full-commit-sha>"
gh workflow run full-release-validation.yml --ref main \
  -f ref="$VALIDATION_SHA" \
  -f expected_sha="$VALIDATION_SHA"
```

Gateway extended-stable runs npm preflight, Full Release Validation, and plugin
npm release from `extended-stable/YYYY.M.33`; core publish consumes those three
run IDs plus the validation attempt. `release-ci/*` evidence is invalid because
publish binds every run to the canonical branch and release SHA. The tag
publishes Gateway images and only the `extended-stable*` aliases; the path skips
the regular orchestrator and its ClawHub, native-app, GitHub Release, website,
and private dist-tag surfaces. See [Monthly Gateway extended-stable
publication](/reference/RELEASING#monthly-gateway-extended-stable-publication)
for commands and recovery.

### Windows Testbox Probe

The manual `windows-testbox-probe.yml` workflow keeps Windows/WSL probing and
headless Windows CI on the selected `runner_label`. The `run_windows_ci` input
(default `false`) requests both headless CI and a separate native Scheduled Task
proof job on GitHub-hosted `windows-2025`. Neither job depends on the other, so
their results remain independently visible; either requested proof failing fails
the workflow.

For both proofs, set `target_ref` to an exact 40-character commit SHA. Both jobs
check out that target, and native proof verifies checkout equality before running
the lifecycle test. Native preflight runs before setup and requires an interactive
Windows session. A noninteractive runner fails qualification rather than silently
skipping proof. Selecting `windows-2025` does not establish native qualification:
the unchanged lifecycle assertions and cleanup must pass on the actual runner.
Cleanup and diagnostic upload still run after failure, and retained evidence is
removed only after cleanup and upload succeed.
