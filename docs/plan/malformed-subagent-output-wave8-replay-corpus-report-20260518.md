# Wave 8 replay corpus report

Date: 2026-05-18
Corpus fixture: `test/fixtures/malformed-subagent-output-wave7-replay-corpus.json`
Focused test: `src/agents/subagent-child-result-rollout.test.ts`

## Coverage

Replay coverage includes:

- polluted sessions;
- clean prose-only subagents;
- read-only auditor completions;
- timeout and cancelled children;
- cron/background tasks;
- direct and queued announcements;
- dashboard/session-history views;
- restart/resume cases;
- golden verified-pass parent evidence;
- adversarial raw source/diff output.

## Expected mapping

- Clean legacy prose-only pass maps to `UNVERIFIED`, not success.
- Polluted/raw sessions map to `MALFORMED` with quarantine metadata.
- Timeout/cancelled children remain terminal non-success.
- Dashboard/session-history views retain metadata only.
- Golden cases reach `VERIFIED_PASS` only with parent-observed evidence.
- Adversarial raw source/diff bodies are excluded from telemetry/dashboard
  reports and ordinary chat.

## Evidence log

The final Wave 8 primary report records the focused replay/rollout suite as
operator-local command evidence. That command evidence is the release
attachment for pass/fail status; this document records the corpus scope and
expected outcomes.
