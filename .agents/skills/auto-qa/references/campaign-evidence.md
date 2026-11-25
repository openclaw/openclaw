# Campaign evidence and counting

Update the existing task record or operator-requested report throughout the run. Record evidence for activities actually in scope; this reference does not require starting live tests, a soak, or a landing campaign. Never place credentials, raw authenticated requests, private transcripts, personal device information, or local secret-store contents in an artifact.

## Campaign header

Record the user-approved scope, explicit fix target if any, actual start time, requested soak duration, current immutable `origin/main` SHA, authorized landing policy, report location, and operator campaign and machine-load budgets. Separately state the next wave's questions, expected outputs, budget, and stopping condition. Record the orchestrator responsible for serialized remote-ref updates. After each landing, record the post-merge fetched baseline only after proving that it contains the recorded merge commit. If the user changes the target, update the active goal and every current ledger denominator while preserving historical time-stamped progress; never treat the old target as campaign completion. An exhausted wave budget is an integration checkpoint, not an overall campaign limit. When the operator's overall budget or an evidence or authority gap stops work before an explicit target is reached, preserve that target and report the remaining work.

## Audit lane

For every active lane record:

```text
lane:
  subsystem:
  question:
  expected_output:
  baseline_sha:
  worker:
  started_at:
  deadline:
  status: queued | running | evidence-ready | failed | timed-out | stale | rejected
  evidence:
```

Record actual worker identities and observed status; planned, completed, failed, timed-out, or stale work is not active concurrency. Select only lanes that answer distinct questions within the current wave's budget. Integrate their results before adding work, and record the unresolved question that justifies each follow-up. There is no minimum lane count and no CLI overflow when agent slots are full. Treat permission to fetch, contact a provider, or run an externally hosted model as a separate network constraint. Track unavailable worker, network, remote, and device capacity explicitly. Direct investigation is useful when workers are unavailable; report any missing independent verification without claiming it occurred.

Freeze one baseline per worker wave. Verify canonical and read-only worker checkouts with both `git -C <verified-checkout> rev-parse HEAD` and empty `git --no-optional-locks -C <verified-checkout> status --porcelain=v1 --untracked-files=all --ignore-submodules=none`; never infer canonical `main` from a desktop task's detached working directory or trust a dirty checkout solely because `HEAD` matches. Require matching commit and clean-content guards at worker start and immediately before report acceptance; immutable Git-object reads are also valid. Keep intentionally dirty fix worktrees outside frozen review waves. A worker may inspect that immutable SHA without independently refreshing shared remote refs. During native PR preparation or merge, pause worker fetches and let the orchestrator own `origin/main`. After a verified landing, fetch again, prove the merge commit is contained in the fetched ref, broadcast that full new SHA, and then resume workers.

## Bug ledger

Count a product bug only after every required field is proven:

```text
number:
summary:
baseline_sha:
affected_owner_and_user_path:
reproduction_before:
observed:
expected:
independent_verification:
root_cause:
affected_callers_and_siblings:
canonical_owner_refactor:
regression_or_live_proof_after:
exact_reviewed_head:
exact_head_hosted_checks:
pull_request:
merge_commit:
risk: low
status: merged
```

Require evidence that the repair eliminates the canonical cause, not only the observed symptom. Record which sibling paths were checked, which were fixed together, and which are unaffected; count a shared invariant once. Keep an independent `review-required` section for persistence, migrations, auth, security, SDK, protocol, high-impact architectural changes, uncertain ownership, and other user decisions. Give the exact reproduction, proposed PR, real completed validation, risk, and outstanding gates. Do not include them in the merged-fix count.

## Long-running evidence

Record the actual start, immutable gateway source, owned live PID and isolated endpoint, elapsed time, exact completed successes, failures, skips, sampled system load, and final end time. Keep an established long-running soak on its original source while current-main review workers advance. A live stress result is incomplete until the specified duration has actually elapsed; an unavailable capability is unavailable, never skipped-and-green.
