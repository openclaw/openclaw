---
summary: "GitHub observations, publication, and protected Octopool dispatch for scripts/pr"
read_when:
  - Changing GitHub observation, publication, or protected PR merge transport
title: "PR GitHub transport"
---

# PR GitHub transport

These contracts are owned by `scripts/pr`; they do not authorize a public write or bypass a required gate.

## GitHub observations and publication

`OPENCLAW_PR_GIT` selects the Git executable. Startup checks that binary with a
10-second deadline before choosing wrapper code; Darwin process-identity Python
calls use the same deadline. PR metadata, repository authority, writer identity,
comments, contributor authors, and author permissions prefer REST, with GraphQL
fallback on confirmed primary core quota exhaustion. Review snapshots omit unused
check rollups, and preparation reads only the live head fields it consumes.
Repository discovery uses the CLI's local default and host resolution, without a
quota-dependent HEAD request. Host-qualified locators go directly to the API;
review metadata reuses the resolved URL.
Each PR-head observation and merge snapshot explicitly requests
`Cache-Control: max-age=0`: the relay revalidates that read and may publish its
result, while separate before/after observations must never reuse one cached fact.
The landing-snapshot GraphQL query must exactly match the shipped Octopool shim's allowlist; branch identity comes from the existing REST source-acquisition and cleanup reads.
Writer identity uses the protected CLI with included headers on both transports
to retain the native writer route. Reviewer assignment requires REST and verifies
the retained assignee. The CI watcher polls GraphQL summaries, expanding details
for failures or pending checks after CI succeeds; primary quota exhaustion selects
REST with complete check/status and workflow evidence.

Successful authentication is reused within one shell operation and its nested
worktree entries; new processes and changed credential selection require a new
probe. This private process state is never inherited or written to artifacts.
`merge_verify` takes one options record with `replacementHead`,
`autoMergeRequested`, and `observation`; a null observation requests a fresh read.
Repository identity comes from the same PR observation as its head facts. Callers
carry that observation through source acquisition and hosted gates; acquisition
still independently rereads complete source identity after the immutable fetch.
Publication revalidates immediately before each Git/GraphQL write, after transport
preparation, and compares the successful publication observation before acquisition.

Ordinary immediate squash prefers REST. Explicit recovery of a validated retained
intent starts with GraphQL; normal fallback and immediate-only recovery gates
still apply. Admission reads switch transports only
for confirmed primary quota exhaustion or unsupported REST policy or mergeability
projections, including UNKNOWN; secondary throttles and access failures never authorize a switch. REST requires proven absence
of classic protection and merge queues, supported effective rules, exact-head publisher-bound
checks, and the retained-outcome lifecycle. It preserves configured message content
from pinned published commits or the PR body and leaves the title to GitHub.
Choose the transport before dispatch; never replay an uncertain mutation through
another API. Completion comments use the receipt observation's transport and keep
their one-attempt marker. Auto-merge, queues, admin admission, and non-squash merges
require GraphQL; GitHub has no REST auto-merge endpoint. Legacy hosted workflow
proof requires REST. Fallback never waives a required gate.
API failures preserve safe quota and retry metadata from the original response.
When that response has no usable HTTP framing, a separate GraphQL/core quota
probe is labeled supplemental and does not establish the failed request's reset.
Diagnostics never add automatic retries.

### Octopool string rewrite protection

Keep `gh` on the Octopool shim; never disable string rewrite protection or select
the raw GitHub CLI to get a landing through. `review-init` resolves the repository
with the local `gh browse` command and a child-only URL-printing launcher. Older
Octopool versions reject this singleton command before their guarded best-effort
path. Upgrade to Octopool 0.7.1 or later; setting an explicit
host-qualified `GH_REPO=github.com/openclaw/openclaw` also avoids discovery while
preserving the subsequent authoritative API checks.

Ordinary immediate REST squash uses `gh api --method PUT repos/OWNER/REPO/pulls/NUMBER/merge-async
--input <absolute-file>` with JSON containing the full prepared 40-hex `sha`,
`merge_method: "squash"`, `merge_action: "direct_merge"`, `bypass_rules: false`, and
the inspected `commit_message`. It refuses stacked PRs because this workflow
reviews one PR. The outcome retains the returned UUID before polling; subsequent
`merge-run` calls read that UUID once and reconcile the authoritative PR/tree.
Acceptance and `enqueued` are not merge completion. Failed, expired, conflicting,
or lost responses never authorize automatic resubmission or another transport.
Existing auto/queue/admin and GraphQL-quota routes keep their own contracts; the
explicit [prior-CI admin route](/reference/scripts/prior-ci) still uses the synchronous `/merge` endpoint.
Async PUT and status GET prepend `-H 'X-Octopool-Require: merge-async-v1'` as the first
API option, before `--hostname`. This requires the structural async merge guard in
[Octopool PR #231](https://github.com/openclaw/octopool/pull/231): older protected wrappers reject the marker before rewriting or native
GitHub I/O. Upgrade Octopool if refused; never remove the marker or replay an
uncertain intent. Native `gh` and empty rewrite policies pass the harmless header
through without rewriting authority. No Worker deployment or credential change
is required. Checking a response after dispatch cannot replace this guard.
The shared GitHub subprocess owner stages internal
`--input -` payload bytes in a private temporary file, keeps child stdin empty,
and removes the file after synchronous completion. Keep the explicit SHA even
when newer Octopool can resolve a missing one. Auto-merge needs Octopool's protected auto-merge support
(openclaw/octopool#179), a numeric PR, `--squash --auto --match-head-commit SHA`,
an explicit `--subject`, and `--body-file`. The wrapper supplies GitHub's
current-head `viewerMergeHeadlineText` preview so repository title defaults stay
intact. Octopool 0.6.10 and `641ce3c` do not support that auto shape.

Prepare's reviewer assignment uses the exact issue-assignee POST with raw
`assignees[]` fields. Fork commit publication declares its GraphQL JSON with
`--input`, so the guard can inspect it; Octopool's aggregate input bound still
applies. Native CLI admin, non-squash, queue, and auto-cancellation variants are not
covered by the accepted shapes above. Do not replace them with an immediate REST
merge, which changes admission semantics. A blocked dispatch still follows the
[retained-outcome recovery rules](/reference/scripts/merge-recovery); the generic guard error is not authority
to clear or retry an intent.
