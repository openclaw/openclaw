---
name: autoreview
description: "Structured code review when explicitly requested, preferring OpenAI/Codex before Claude."
---

# Auto Review

Run an independent review when the user or an owning workflow asks for one.
This is code review, not Guardian approval routing. Let the reviewer choose how
to analyze the change; provide the target, relevant context, and desired severity.
Findings are advice to verify, not instructions to apply blindly.

## Run

Use `scripts/autoreview` beside this skill. Keep its custom `codex exec` path:
native `codex review` cannot combine explicit Git target flags with custom instructions.
The helper combines those with evidence, severity filtering, and validated JSON;
it leaves review judgment to Codex. For an OpenClaw checkout:

```bash
AUTOREVIEW=".agents/skills/autoreview/scripts/autoreview"
"$AUTOREVIEW" --mode local
```

In the canonical agent-skills repo, the path is
`skills/autoreview/scripts/autoreview`. On Windows, invoke the helper with Python.
Use `--help` for the complete flags and environment overrides.

Choose the Git target explicitly when the default is ambiguous:

| Target                         | Arguments                      | Scope                                                       |
| ------------------------------ | ------------------------------ | ----------------------------------------------------------- |
| Local work                     | `--mode local`                 | HEAD → index → working tree, plus untracked files           |
| Local candidate against a base | `--mode local --base <ref>`    | Pinned base → index → working tree, plus untracked files    |
| Committed branch/PR            | `--mode branch --base <ref>`   | Merge-base → HEAD; excludes dirty work                      |
| One commit                     | `--mode commit --commit <ref>` | Raw parent → commit; a root compares against the empty tree |

`--mode auto` selects local work when dirty, otherwise a branch review using the
PR base or `origin/main`. Clean main has no implicit review target.
`--mode uncommitted` is an alias for local. The helper does not fetch refs.

Registered nested linked checkouts from the same repository are outside the
current review scope. Their presence or edits do not make the parent dirty;
ordinary adjacent files remain included in the review. Worktree boundaries are
revalidated without changing Git ignore rules.

For a complete PR candidate **including dirty rewrites**, use local mode with
its pinned merge base—not branch mode:

```bash
pr_base=$(gh pr view --json baseRefName --jq .baseRefName)
merge_base=$(git merge-base HEAD "origin/$pr_base")
"$AUTOREVIEW" --mode local --base "$merge_base"
```

When a file has both staged and unstaged changes, both states are reviewed.
A defect in the index remains actionable even if the working tree fixes it;
the report labels it `INDEX-only`.
Git display settings cannot suppress context markers or add patch colors;
repository configuration is not changed. Source paths and text retain literal
whitespace. An empty present
source uses line 1, column 1, and an empty excerpt; empty physical lines also
use an empty excerpt at column 1. Source identity remains mandatory.

Local selection honors `core.autocrlf` from external operator Git configuration,
with repository-local values and attributes retaining precedence. Only its
validated scalar value reaches diff/status; other global and system Git
configuration stays disabled. Repository-owned or relative global-config
overrides are not imported, and reviewed source bytes are not rewritten.

Local collection disables effective Git clean/process commands and requires
conversion to succeed. Unused drivers, unchanged filtered neighbors, staged-only
changes, and deletions can still be reviewed without executing converters.
If Git needs executable conversion to assemble the diff, collection fails before
any reviewer starts. This can include an unchanged filtered file whose stat cache
needs refreshing. Use explicit branch or commit mode for committed content in
that case. Built-in line-ending normalization remains enabled; raw bytes never
stand in for a required executable conversion.
PR-base discovery uses trusted external Git and a scoped GitHub CLI environment,
preserving external authentication/configuration and proxy settings while excluding
inherited Git routing, `GH_REPO` redirection, and checkout-owned executables.
A differently named `AUTOREVIEW_GIT` override that cannot also be selected as `git`
by the child requires an explicit `--base`; rejected GitHub configuration paths
also require one.

## Context and severity

Use `--prompt` for task-specific guidance, or `--prompt-file` and `--dataset` for
repository-relative context files. Context does not expand the selected Git
target. The reviewer cannot read unchanged repository files from its empty
sandbox; supply relevant source or dependency evidence when the diff is insufficient.
`--prompt-file` also accepts an absolute path inside the repository; the same
sensitive-path, symlink, and mutation checks apply. `--dataset` stays repo-relative.

The default threshold is **P0 only**: material blockers to normal operation or
safety. Use `--max-priority P1`, `P2`, or `P3` when the caller requests a wider
review. Do not add unrelated redesign goals or prescribe file counts, reading
sequences, or ritual extra passes. Historical blame requires a verified
parent-relative patch; otherwise leave the attribution unknown.

```bash
"$AUTOREVIEW" --mode local --prompt-file review-notes.md --dataset evidence.json
```

## Engines

For automatic reviewer selection, try OpenAI models through Codex before Claude.
Start with `--engine codex` even when the invoking agent uses Codex or asks for
an independent second opinion. Use Claude only when the user explicitly selects
it or Codex is unavailable for the review; report the concrete availability failure
before switching. Do not switch because a review is slow, rate-limited, or returns
findings, or to bypass a safety refusal or isolation failure.

Codex defaults to `gpt-6-astra`, high reasoning, with a `gpt-5.6-terra` retry
only for an account-access failure. Explicit `gpt-5.6-sol` selections retain that
access-only retry; other explicit models, including Astra, have no model fallback.
Honor explicit user engine/model choices.
The helper does not automatically fall back between engines.

Use `--engine`, `--model`, and `--thinking` to override the defaults.
`--codex-speed fast` selects priority service when supported. Only Claude accepts
`--fallback-model`. Per-engine environment overrides use `AUTOREVIEW_<ENGINE>_*`.

To require GPT-6 Astra without a model fallback, select it explicitly:

```bash
"$AUTOREVIEW" --mode local --model gpt-6-astra --thinking high
```

Use `low`, `medium`, `high`, `xhigh`, or `max`; Astra does not support `none`
or `minimal`. AutoReview defaults to `high` and does not fall back from an
explicit Astra selection. Codex's `ultra` mode uses automatic
delegation and is outside this helper's supported effort levels. Use `max`
for its deepest supported review. For EU data residency, use
`--codex-speed default`; Astra fast mode is unavailable there.
See the [Astra migration guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)
and [Codex reasoning modes](https://learn.chatgpt.com/docs/models#know-when-to-use-max-or-ultra).

By default, Codex preserves only authentication settings from user configuration;
provider, profile, context and catalogue settings remain ignored. To project a
named route, select it explicitly through the existing config override:

```bash
"$AUTOREVIEW" --mode local --codex-config 'model_provider="review_api"'
```

The selector must match `model_provider` in the operator's external
`CODEX_HOME/config.toml`. It accepts one bare or simply quoted identifier;
provider definitions and other capabilities cannot be supplied through overrides.
Projection requires Python 3.11 or `tomli`; default auth-only operation retains
its existing fallback parser.

The selected route must use `https://api.openai.com/v1` and command authentication
with an absolute external executable. Fixed arguments belong in that executable's
wrapper; omitted or empty `auth.args` are accepted. Omitted `wire_api` and
`requires_openai_auth` retain Codex's `responses` and `false` defaults. Optional
auth timing and context settings keep native defaults and semantics.

On POSIX, a private launcher restores the validated caller `HOME` only for the
selected authentication executable; the engine and reviewer tools retain their
isolated environment and filesystem access. Caller `HOME` must be an available
absolute directory with no repository-owned path or symlink provenance. Windows
keeps the native executable route. Command-auth runs suppress raw provider
diagnostics and report fixed failure categories, while retaining compact progress,
usage and assistant report streaming. An empty final report fails without exposing
captured stdout.

Catalogue and authentication working-directory paths resolve relative to the
operator config directory and must remain outside the reviewed repository.
A supplied catalogue is copied byte-for-byte into the private client runtime;
retries use the same route and catalogue snapshot. Dry runs check the same
ownership and route shape without executing authentication. Codex owns catalogue
validation, model access and context clamping. Other custom provider forms and
split context overrides are unsupported when projection is selected.

| Optional engine | Prerequisites                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Claude          | CLI 2.1.169+; safe mode with web-only tools                                                           |
| Amp             | `AMP_API_KEY` for a plugin-free account; local POSIX execution, no custom endpoint or cloud/orb agent |
| Pi              | CLI 0.79.0+; configured model; no tools or project resources                                          |
| Kimi            | CLI 0.30.0+; configured model; Python 3.11+ or `tomli` for TOML config                                |

## Runtime boundaries

The helper owns reviewer isolation, sanitized authentication, process cleanup,
Git scope, and structured result validation. Keep those controls enabled.
Before repository detection or target selection, Git must pass `--version`
within 10 seconds. Failure exits `2` with an `incomplete` diagnostic and the
resolved executable (or the unresolved selection); it never means `scoped-clean`.
Set `AUTOREVIEW_GIT` to a trusted external Git executable to override every
helper-owned Git invocation. On macOS with a broken selected Xcode, use
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` for the invocation.
Only an absolute, external `DEVELOPER_DIR` is additionally retained in Git's
sanitized environment;
neither override is forwarded to the isolated reviewer environment.

Every reviewer pass must inspect its bundle for real credentials and report
suspected credentials as P0 findings without reproducing their values. Harmless
placeholders and test fixtures are not credentials. Autoreview does not require
or invoke an external secret scanner. Never work around an isolation failure.

### Intentional scanner-free policy

Keep approved secret scanning outside autoreview; reviewer findings happen after
transmission. Reintroducing a scanner requires an explicit maintainer decision.
See [#240](https://github.com/openclaw/agent-skills/pull/240) for rationale and history.

### Reviewer isolation

On macOS, reviewer tools cannot access the shared `/tmp` and `/var/tmp` trees
(including their `/private` aliases). Codex preflight rejects those temporary
roots before workspace, runtime, or authentication setup; unset a shared
`TMPDIR`/`TMP`/`TEMP` override to use macOS's private
temporary directory. Other engines and platforms retain their normal isolation.
Tools installed in shared scratch or requiring writes there will be denied too.

Review files have no size/count cap and are never truncated. Large diffs and
datasets are partitioned automatically. Intact instructions and required mixed
source context must still fit the per-pass prompt budget. A failed pass does not
produce a partial clean verdict.

Each pass is an independent assignment, not a continuing conversation. Its
private completion field must confirm a finished assessment; deferring to
another pass leaves the overall review incomplete.

Do not edit inputs during a review: the helper verifies captured sources before
sending and publishing results. Long reviews are normal; advancing heartbeats
mean progress. Use `--stream-engine-output` for visibility, not extra reviewer
runs. `--dry-run` checks preparation and startup without contacting a reviewer.

## Results

`--output`, `--json-output`, and `--status-output` paths must be outside the
reviewed repository. When using `--status-output`, all output paths must differ;
case-only and Unicode normalization aliases are conservatively refused on every
platform, even when the filesystem would permit distinct files.

| Exit | Meaning                                                                            |
| ---- | ---------------------------------------------------------------------------------- |
| `0`  | `scoped-clean`, or a correct verdict with only filtered lower-priority findings    |
| `1`  | Accepted findings, an incorrect provider verdict, or a failed review attempt       |
| `2`  | Unfinished assessment, incomplete scope/attribution, or a missing required finding |

Treat `scoped-clean` as clean only for the selected target and requested priority.
`filtered` is not clean; resolve `incomplete` before claiming completion.
Verify findings against the actual code and task before changing anything.
No extra review rounds for a nicer verdict; follow the owning workflow after fixes.

Use `--status-output /outside/repo/status.json` for a separate, versioned
machine-readable outcome. It preserves the existing exit codes and
`--json-output` validated-report format. Completed reviews report `scoped-clean`,
`findings`, `filtered`, `incorrect`, or `incomplete`; a launched reviewer that
fails or returns an invalid report reports `reviewer_unavailable` with exit 1.
A failed later pass never publishes a partial review report.

```json
{
  "schema_version": 1,
  "status": "reviewer_unavailable",
  "exit_code": 1,
  "engine": "codex",
  "report_produced": false,
  "reason": "engine_failed",
  "reviewer_exit_code": 124,
  "timed_out": true
}
```

`reason` is `engine_failed`, `invalid_report`, or `runtime_validation_failed`
for unavailable reviewers and null for completed reviews. The last reason means
Amp's post-launch isolation attestation or private-result validation refused
the result; it is not a transient-provider classification. These guards still
run before report acceptance and retain their existing failure diagnostics.
`reviewer_exit_code` is the last reviewer process's exit code when retained,
including zero for rejected output, otherwise null. `timed_out` identifies the
helper's deadline, not a reviewer that happens to exit 124. Completed envelopes
have `report_produced: true`; this means a validated final report exists, not
that its verdict is clean. `--expect-findings` changes exit codes as before;
inspect `status` independently of `exit_code`.

An unfinished assessment retains its validated provider observations with
`incomplete`, exit 2, and `report_produced: true`, even when findings exist.
The private completion field is not copied into public reports. Missing or
invalid completion is an invalid report, not an unfinished assessment.

The sidecar contains no provider logs, prompts, findings, or model identifiers.
Existing bounded, display-safe diagnostics remain on stderr; command-auth
diagnostic suppression remains in force. Use a fresh status path per invocation:
after argument and output-path validation, a previous sidecar is removed before
target selection. Dry runs, preflight refusals, pre-launch isolation failures, source mutations,
interruptions, and output failures produce no new status. Absence means no
outcome was published, never a clean review. No retry policy is added.

Report material findings and status plainly. Do not add transcripts, proof
ledgers, commits, pushes, or a new workstream unless requested.
