# Similar Issue Search

Search before filing. Prefer exact error strings first, then broader symptom language.

## GitHub CLI Queries

```bash
gh search issues "repo:openclaw/openclaw is:issue \"not responding\""
gh search issues "repo:openclaw/openclaw is:issue slow agent"
gh search issues "repo:openclaw/openclaw is:issue timeout gateway"
gh search issues "repo:openclaw/openclaw is:issue plugin validation"
gh search issues "repo:openclaw/openclaw is:issue auth profile provider"
gh search issues "repo:openclaw/openclaw is:issue exact error phrase here"
```

If `gh search issues` is unavailable, use GitHub web search with:

```text
repo:openclaw/openclaw is:issue <symptom or exact error>
```

## What To Link

- Exact same error, even if the user-visible symptom differs.
- Same plugin, provider, auth profile, gateway mode, model, or transport path.
- Same regression window or release version.
- Prior issues closed as fixed if the current report suggests a regression.

## Duplicate Decision

Comment on an existing issue when the root symptom and likely subsystem match. File a new issue when the logs show a different subsystem, the existing issue lacks enough evidence, or the old issue is closed and the current version appears to regress.

## Duplicate Search Record

Record this in the final issue or existing-issue comment:

- Exact error queries:
- Symptom queries:
- Plugin/provider/model queries:
- Open matches and result counts:
- Closed/regression matches and result counts:
- Top candidate issues:
- Selected related issues:
- Duplicate decision: new issue / comment on existing issue / unclear
- Reason:
