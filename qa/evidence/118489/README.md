# PR #118523 evidence artifacts (redacted)

Redacted QA verdict JSONs and the codex-cell transcript for the failed-tool
finalization residual proofs. Files are committed so reviewers can inspect them
directly in the PR.

## Files

- `parity6-qa-evidence.json` - official `openclaw.qa.evidence-summary` v2 verdict
  for the runtime-pair run: `qa-channel-failed-tool-presentation-terminal-finalization`
  = pass (`known harness gap in openclaw runtime; paired runtime passed`).
- `codex-cell-transcript-excerpt.json` - the codex cell session transcript
  (redacted): failing `read` (real ENOENT, persisted exactly once), successful
  presentation-producing `web_fetch` (HTTP 200), final delivered reply
  `QA-FAILED-TOOL-PRESENTATION-FINALIZED-OK`, no tool replay.
- `channel-118274-qa-evidence.json` - pass verdict for
  `qa-channel-failed-tool-terminal-finalization` (calls=1 failed=1 finalizations=1).
- `cron-118274-qa-evidence.json` - pass verdict for
  `cron-failed-tool-terminal-finalization` (calls=1 failed=1 finalizations=1).
- `codex-contract.md` - direct excerpts of the `openai/codex` protocol source
  for the item-id / event-order contract the stale-lifecycle premise depends on.

## Commands

```sh
OPENCLAW_ENABLE_PRIVATE_QA_CLI=1 node openclaw.mjs qa suite --repo-root . \
  --provider-mode mock-openai --transport qa-channel \
  --runtime-pair openclaw,codex --runtime-pair-lane core \
  --scenario qa-channel-failed-tool-presentation-terminal-finalization \
  --output-dir .local/qa-evidence-parity6
```

Redaction: suite workspace paths and loopback ports replaced with placeholders;
no credentials present.
