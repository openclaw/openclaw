# Diagnostic and result guidance

## Local stage diagnostic

Use `--engine-stage-dir /outside/repo/fresh-private-directory` with
`--stream-engine-output` to observe the first streamed Codex process. The caller
must create and exclusively hold a fresh directory with mode `0700` on responsive
local POSIX storage. The helper never creates the directory or overwrites an
existing `engine-stage.json`. The option has no environment-variable activation
and produces no observation for other engines, buffered output or dry runs.

The separate sidecar contains only closed booleans and enums, at most 4096 bytes.
It reports local launch, read, parser and display observations plus that first
process's terminal state. Later retries and passes do not update it. Its terminal
can differ from the overall review outcome. `spoofable` is always true;
`provider_receipt` and `acceptance` are always false. Missing or false observations
mean unknown. They never prove provider activity, native initialization or review
acceptance. The normal redaction wrapper conservatively leaves flushed-display
observations unknown, even when visible output succeeds.

Ordinary observation and persistence failures preserve the primary result.
Persistence rejects repository paths, symlinks, unsafe ownership and permissions,
and publishes without overwriting existing names. Failed name cleanup can leave
a private `.engine-stage.partial`; failed descriptor closure can remain unresolved.
Ambiguous closes are not retried. Cancellation still propagates, and a new cleanup
cancellation can replace a pending exception after remaining cleanup attempts.
The contract assumes ordinary descriptor acquisition and assignment, trusted
caller custody and responsive local storage. It does not cover hostile same-user
interference, concurrent descriptor reuse, arbitrary instruction interruption,
stalled or network filesystems, or crash durability. Keep custody when clearing a
failed partial file. This diagnostic does not change reports, usage, deadlines,
exit codes or reviewer isolation.

## Results

`--output`, `--json-output`, and `--status-output` paths must be outside the
reviewed repository, both for the final directory entry after resolving parent
symlinks and for the resolved referent. Without `--status-output`, `--output` and
`--json-output` must name different final directory entries after resolving parent
symlinks. Distinct final symlinks or hardlinks may share an existing referent because
publication replaces their separate entries. With `--status-output`, all output
paths must have distinct resolved referents; hardlink aliases are refused too.
Case-only and Unicode normalization aliases at the applicable boundary are
conservatively refused on every platform, even when the filesystem would permit
distinct files.
Tilde and relative destinations are expanded once before validation and remain
anchored to the invocation directory. Atomic report writes replace a final
symlink instead of modifying its target.

For event-stream results, the last terminal event is authoritative. An invalid
final result fails the review, even if an earlier event or review pass contained
a valid report; earlier reports are never published as a partial clean result.
A non-null `structured_output` must contain the report object; only an absent
or null field permits using the event's `result` instead.

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

Codex runs collect usage with live display on or off. The final report, status
sidecar, and terminal summary include `usage`: process attempts, reported,
unknown and partial attempt counts, `complete`, and observed token totals.
Each fresh attempt contributes its last valid cumulative snapshot once, including
access retries and failed passes. The default GPT-6.1 Sol reviewer retries GPT-6
Sol once only on an account-access failure; this retry does not chain to Luna.
Network, rate-limit, capacity, and unsupported-effort errors do not select a fallback.
Cached input and reasoning output are subsets
of input and output, not extra totals to add. These are observed tokens, not a
billing estimate or a cache-hit promise. Missing telemetry, including Codex's
all-zero defaults when no sample exists, is unknown, never measured zero;
`tokens: null` means no attempt supplied usable totals. When `complete` is false,
available totals are a lower bound. Interrupted runs print retained usage but
still publish no status or review report. Other engines do not yet aggregate usage.

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
