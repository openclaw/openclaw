## Full Generation Runs

For a direct full scorecard run that publishes the generated-doc pull request,
use floating `main` resolution by default:

```bash
gh workflow run maturity-scorecard.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f ref=main \
  -f expected_sha='' \
  -f publish_pull_request=true \
  -f allow_failures=true
```

Do not resolve `main` locally and pass that commit as both `ref` and
`expected_sha` for an ordinary manual generation run. OpenClaw's `main` moves
quickly, so the caller-selected commit can become stale before validation. The
workflow then correctly rejects publication when the pull request base contains
newer maturity inputs, and QA never starts.

With `ref=main` and a blank `expected_sha`, the workflow's
`floating_default_branch` path fetches and freezes the current remote default
branch inside validation before handing an immutable revision to downstream
jobs. Use an explicit SHA only when the requested evidence must remain bound to
that exact revision, such as a release-candidate workflow call or an
artifact-only historical reproduction. If that exact-revision run also requests
publication and `main` has changed relevant inputs, expect validation to fail and
dispatch again from floating `main` instead.
