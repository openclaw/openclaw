# Session Lock Compaction Ownership Race Closeout

Date: 2026-06-22

## Status

Closed locally. No push, restart, or deploy was performed.

## Root Cause

Threshold compaction could append a compaction entry and rotate to a successor transcript while another controller still treated the session file change as external ownership drift. That made legitimate post-prompt writes look like takeover candidates after compaction.

After-compaction hooks also reported the original session file path even when the compaction result supplied the effective rotated session file.

## Files Modified

- `src/agents/sessions/agent-session.ts`
- `src/agents/embedded-agent-subscribe.handlers.compaction.ts`
- `src/agents/embedded-agent-runner/run/attempt.session-lock.test.ts`
- `src/plugins/wired-hooks-compaction.test.ts`

## Fix Summary

- Added an owned-write option to the session write-lock runner.
- Wrapped compaction transcript writes in an owned session write-lock publication.
- Resolved the effective post-compaction session file from the compaction result before running after-compaction hooks.
- Added regression coverage for post-compaction writes and rotated session-file hook payloads.

## Validation

- `git diff --check`: passed.
- Focused Vitest rerun:
  - `node scripts/run-vitest.mjs run src/agents/embedded-agent-runner/run/attempt.session-lock.test.ts src/agents/embedded-agent-subscribe.handlers.compaction.test.ts src/plugins/wired-hooks-compaction.test.ts`
  - Result: 3 test files passed across 2 Vitest shards; 58 tests passed.
- Previous focal run recorded before closeout: 3 files passed / 95 tests passed.

## Rodolfo Post Audit

`RODOLFO_POST_AUDIT=PASS`

Required changes: none.

## Rollback

Local rollback is one revert of the patch commit:

```bash
git revert a894132d8e1a314cb38ec44505f5fd26766e1090
```

If the documentation closeout commit is present and must also be removed:

```bash
git revert <closeout-commit-hash>
```

## Operational Boundaries

- No push.
- No restart.
- No deploy.
- No production service changes.
- No real Telegram bot test.
