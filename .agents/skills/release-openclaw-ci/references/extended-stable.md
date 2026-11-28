# Release CI: extended stable

### Extended-stable validation

For `.33+` use candidate-owned helper: exact frozen branch-tip C; Q=C or assessed Q (including its authorized ledger-only descendant) owning full qualification closure; independently trusted P admits/verifies. Canonical `extended-stable/YYYY.M.33` supplies context, not workflow authority. Deliberately repair Q/backport missing contracts, never silently follow main.

```bash
VALIDATION_SHA="<exact-candidate-sha>"
PUBLISHER_SHA="<recorded-full-trusted-main-ancestor-sha>"
CONTEXT_REF="extended-stable/YYYY.M.33"
pnpm ci:full-release \
  --sha "$VALIDATION_SHA" \
  --target-ref "$CONTEXT_REF" \
  --admission-workflow-sha "$PUBLISHER_SHA" \
  --admission-workflow-ref main \
  -f validation_purpose=publish \
  -f publication_selection_json='{"route":"extended-stable","npmDistTag":"extended-stable","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}' \
  -f release_profile=stable \
  -f run_release_soak=true \
  -f fail_fast=false \
  -f rerun_group=all \
  -f reuse_evidence=false \
  -f dispatch_release_evidence=false
```

- Helper freezes npm baselines before admission. Primary cross-OS/survivor upgrade baseline: newest published extended-stable below candidate (**2026.8.35 → 2026.9.33**). Survivor set also keeps frozen month's newest stable predecessor (**2026.9.9**). Extended-stable upgrades exercise old updater's real `extended-stable` selector against loopback candidate registry, never explicit `--tag`.
- Only the helper creates the immutable post-admission `release-ci/<Q-prefix>-<timestamp>` transport. Never raw-dispatch, manually create its ref, or mint a Q protected publication tag. Historical cross-revision publish requests retain original identity, never candidate-owned labels. A new explicit main/protected route is diagnostic, main-qualification, or postpublish-confidence only; it cannot replace this admitted C/Q/P publish proof.
- Require complete `rerun_group=all` with supported exact-target manifest. Bind workflow SHA separately from C; manifest target, package versions, saved `run_attempt`, final tag must identify same candidate. Reject narrow runs, untrusted tooling, target mismatches, earlier attempts.
- Parent prepares core/selected-plugin tarballs into immutable `publicationArtifacts`; publish those exact artifacts/attempts. Standalone npm/plugin preflight is diagnostic, never manifest-bound replacement.
- Product failure needs approved backport; frozen-target tooling failure needs smallest behavior-preserving repair. Provider/approval/runner/log races keep candidate unchanged. Record repairs/superseded runs; every branch change needs new complete parent. Omit only explicitly unsupported frozen-target scenarios, never required behavior/package.

### Frozen-target test omissions

| Initial-dispatch JSON array                    | Exact allowed paths/lane                                |
| ---------------------------------------------- | ------------------------------------------------------- |
| `plugin_prerelease_node_exclude_patterns_json` | `src/plugins/` tests, Plugin Prerelease Node            |
| `extension_test_exclude_patterns_json`         | `extensions/` tests, Plugin Prerelease extension shards |

- Normal CI does not own this sweep. Both default `[]`; no implicit Codex omission. Retain justification/owning fix; omitted coverage = not run.
- Preflight must discover every requested path in selected frozen lane. Nonexistent/out-of-lane/duplicate/basename/glob inputs fail loudly.
- Trusted tooling excludes exact inline Vitest leaves, preserves candidate runtime preparation, then restores config bytes. No CLI `--exclude` or new target-side environment variable: frozen inline projects may ignore them.
- Inputs remain in immutable request, coverage/reuse identity, final manifest. Changes require new request, never continuation.
