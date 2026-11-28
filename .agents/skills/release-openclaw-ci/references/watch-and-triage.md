# Release CI: watch and triage

## Watch

Use the attempt-aware controller:

```bash
pnpm frv watch --run <full-release-run-id>
```

- Resolves IDs from parent dispatch logs (`Dispatched <workflow>: <url> (attempt N)`), never display titles. Reports every parent/child attempt transition and failed job once, with runner labels.
- Retries transient GitHub 5xx/HTML bodies next poll, never as job results.
- State: `$TMPDIR/openclaw-frv/<repo>-<parent>-watch.json` (`--state` overrides). Harness/Monitor timeout restarts do not re-report. `--once` snapshot; `--interval <seconds>` (default **60**); `--json` NDJSON.
- Newly observed current-parent/artifact-producer blocker or policy-blocking carried failure: save notification, exit **1**. Resume same command/state for diagnostics without duplicates. Otherwise exits when parent/all dispatched children terminate; restart after later rerun. Use `status` for structured blockers, `continue --failed --dry-run` to preview recovery. No custom bash/`gh` watchers.
- Candidate events use frozen SHA/context from sealed plan, not monitor prose/tooling SHA. Read tip freshly: changed tip labels candidate superseded, but observation continues and never qualifies new tip. Missing evidence/SHA-only context stays unknown.
- Resume missing/exited watcher with same command/state: read-only, suppresses prior terminal/candidate events. Never redispatch to restore watching.

Release Decision transition-only watcher:

```bash
node scripts/release-ci-summary.mjs <full-release-run-id> --watch
```

- Do not start while SHA-pinned helper owns foreground; helper reads exact Decision artifact itself.
- On `blocked_diagnostics_running`, helper exits nonzero immediately, retains temporary workflow ref, and leaves Drain collecting terminal evidence. For separately dispatched parents, summary watcher likewise reports blocker once/exits while Drain continues.

One-shot snapshot:

```bash
node scripts/release-ci-summary.mjs <full-release-run-id>
```

- `release-ci-summary` accepts FRV parents only. Diverged release-branch logs: `--first-parent` plus bounded count. Stop watchers before turn end/strategy change.
- PR/child gates: inspect exact workflow run, not `commits/<sha>/check-runs` (retains superseded/cancelled entries; stale failures can mask success). Resolve newest head `CI` via `actions/runs?head_sha=<sha>`, read its `openclaw/ci-gate` jobs before retry/report.

| State                         | Meaning/action                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `qualifying`                  | No decisive blocker; selected children active.                                                                                                                           |
| `blocked_diagnostics_running` | Publish blocked, Drain collecting independent failures. Diagnose now; `frv rerun`/`continue --failed` once failed child terminal. Final reseal awaits complete evidence. |
| `passed`                      | All required policy/exact-child evidence passed.                                                                                                                         |
| `blocked_complete`            | Publish blocked; selected diagnostics terminal.                                                                                                                          |
| `orchestration_error`         | GitHub API/collector prevented verdict, not proof of wrong source. Recover collector against same exact children; never redispatch tests for collection.                 |
| `cancelled_with_children`     | Collector cancelled with exact children active.                                                                                                                          |

Read actual conclusions for every selected lane. `passed` requires pinned P's policy, terminal evidence, retained raw waived failures. Omitted coverage is not run, never passed.

- Terminal failures/timing: `full-release-diagnostics-<run-id>-<attempt>`. After early blocker, read it rather than restart all just to discover remaining failures.
- Collector identity: stable `full-release-execution-plan-<run-id>`; retries first restore immutable run-ID-cached bytes.

## Failure Triage

1. Confirm parent SHA/child IDs.
2. `pnpm frv watch --run <parent> --once` lists failed jobs with attempts, runner labels, URLs.
3. Fetch one failed-job log. If rate-limited, record reset time; stop REST calls.
4. Secret-looking failure: prove real completion from same secret source before code edits; model-list success is insufficient. Claude CLI subscription auth is separate: clean-home CLI probe, never substitute for required Anthropic API-key lane.
5. Live cache: distinguish missing/invalid key, empty text, provider refusal, timeout, baseline miss. Never weaken release gates without clear provider evidence.
6. Before edits, decide blocker/flake per failed test. Preserve diagnostics, inspect **every same-SHA attempt**, and run:
   - `git log <previous-release-tag>..<release-sha> -- <failing paths>` (candidate delta).
   - `git log <release-sha>..origin/main -- <failing paths>` (main-only changes).
   - An applicable deterministic repair on main but absent from the frozen candidate means blocker: backport/supersede, never rerun as inherited success. Apply [the flake presumption and bounded retry policy](recovery.md#diagnose-before-retrying), including prior-run passes with unaffected inputs and apparent infrastructure/test flakes. Investigate production-impacting races as defects. Track flake fixes on main; every unwaived selected job must pass pinned P's publication policy.

| Blocker                                                                                  | Recovery                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed product/code                                                                   | Fix release branch, freeze new Code SHA, invalidate product evidence.                                                                                                                                                                                                                                                                                                                                                                                                  |
| Qualification harness/contract                                                           | Keep C; tooling-only repair, new admission/request with reviewed exact Q and successful parent. Preserve superseded evidence/invalidation reason.                                                                                                                                                                                                                                                                                                                      |
| P-only admission/verifier/publisher                                                      | Keep C/Q/original artifacts; repair independent trusted P and affected surface.                                                                                                                                                                                                                                                                                                                                                                                        |
| Infrastructure/credentials                                                               | Keep C/Q/P; repair external prerequisite, retry failed surface only.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Wrapper/monitor                                                                          | Keep child/candidate identities; record wrapper result separately.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Changelog/notes                                                                          | Change selected entry/permitted record/index only under `split-changelog-release-v1`; retain Code-SHA evidence, repeat Release-SHA proof.                                                                                                                                                                                                                                                                                                                              |
| Publish child/registry selector                                                          | Keep Release SHA, resume failed child; never rebuild published immutable version.                                                                                                                                                                                                                                                                                                                                                                                      |
| Parent failed after core npm (e.g. stale `beta` dist-tag completion verification)        | Keep successful original npm run/qualified bytes; repair selector; reconcile exact failed-parent children before route resume. Direct finalization normally waits for npm/Docker verification; prepared button retains core checks. Neither waits for ClawHub downloads. Never manually undraft around core gates. [Direct resume/new prepared-button recovery](../../release-openclaw-maintainer/references/publication-recovery.md#published-version-failed-parent). |
| Child `waiting`, ClawHub `Artifact not found`, `ClawHub dispatch blocked by waiting run` | [Publish children](publication.md#publish-children).                                                                                                                                                                                                                                                                                                                                                                                                                   |

Only product defects require changing C; qualification repairs may change Q via new admission. Reassess after one diagnosis/fix/narrow retry, not another automatic all-group cycle.

7. Runner routing:
   - FRV CI/Plugin Prerelease: hosted `ubuntu-24.04` (or release group). Other lanes follow `OPENCLAW_CI_RUNNER_BACKEND`: `github` moves them off Blacksmith during outage, except QA Lab runtime-pair fails hosted and stays queued on Blacksmith.
   - Release Checks prints `Release runner routing` during flip. Codex extension tests use file-bounded Plugin Prerelease jobs (hosted batch took **36–60 minutes**).
   - Repeated npm-preflight Blacksmith loss: fresh FRV with `-f npm_preflight_use_github_hosted_runners=true`, not repo-wide flip.
8. Required PR CI queued with **no active jobs**: do not cancel unrelated work or accept generic manual dispatch.
   - Verify current fallback schema on PR head: `gh api 'repos/openclaw/openclaw/contents/.github/workflows/ci.yml?ref=<pr-head-branch>' --jq .content | base64 --decode | rg -q 'pull_request_number:'`.
   - If absent, refresh head from main, use new SHA, and let normal CI run before fallback.
   - Dispatch from head branch: `gh workflow run ci.yml --repo openclaw/openclaw --ref <pr-head-branch> -f target_ref=<full-pr-sha> -f pull_request_number=<pr-number> -f include_android=true -f release_gate=true`. Hosted fallback is accepted only with title `CI release gate <full-pr-sha>`. Ledger stalled Blacksmith/fallback runs.
   - If sole remaining gate `Blacksmith Build Artifacts Testbox` is still queued runnerless, completed exact fallback can cover it: `build-artifacts` already builds/packages/smoke-tests artifacts. Not after artifact workflow starts or completes non-successfully.
