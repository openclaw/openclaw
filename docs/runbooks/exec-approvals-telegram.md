# Exec Approvals — Telegram Fix Runbook

## What this covers

Local fix for the Telegram exec approval "unknown approval id" regression.
Use this runbook after any `openclaw update` or `git pull` to verify or restore the fix.

## Design Decisions

### Why full UUID (36 chars) as default display

The approval slug was 8 chars — enough for human readability but ambiguous when
the gateway resolves IDs by exact `Map.get()`. Showing the full UUID eliminates
the mismatch between what the user copies and what the gateway expects. The
tradeoff (longer text) is acceptable because the approve commands are in
copyable code blocks.

### Why prefix match only when unambiguous

Prefix matching is a convenience fallback for users who manually type short IDs.
It must be unambiguous (exactly 1 pending match) to prevent approving the wrong
command. If 2+ pending approvals share a prefix, the gateway returns
`"ambiguous approval id prefix — use more characters"` rather than guessing.

### Why one code block per approval option

Telegram collapses multi-line code blocks into a single tap-to-copy unit.
Grouping all three options (`allow-once`, `allow-always`, `deny`) in one block
would force the user to manually edit after copying. Separate blocks = one tap
per option, zero editing required.

---

## Pre-Update: Save the Patch

```bash
cd ~/openclaw

# Regenerate patch from current diff (if not already saved)
git diff HEAD -- \
  src/agents/bash-tools.exec-runtime.ts \
  src/gateway/exec-approval-manager.ts \
  src/gateway/server-methods/exec-approval.ts \
  src/infra/exec-approval-forwarder.ts \
  src/infra/exec-approval-forwarder.test.ts \
  > .claude/patches/exec-approval-telegram-fix.patch

# Also capture the new test file
git diff --no-index /dev/null src/gateway/exec-approval-manager.test.ts \
  >> .claude/patches/exec-approval-telegram-fix.patch 2>/dev/null || true
```

## Post-Update: Verify Fix Is Intact

```bash
bash .claude/patches/verify-exec-approval-fix.sh
```

Expected: `All checks passed. Fix is intact.`

Or manually:

```bash
grep "APPROVAL_SLUG_LENGTH = 36" src/agents/bash-tools.exec-runtime.ts  # must match
grep "findByIdOrPrefix" src/gateway/exec-approval-manager.ts             # must match
grep "findByIdOrPrefix" src/gateway/server-methods/exec-approval.ts      # must match
grep "Reply with:" src/infra/exec-approval-forwarder.ts                  # must NOT match
```

## Post-Update: Check If Upstream Absorbed the Fix

```bash
# If all 4 grep checks above pass after update, upstream has the fix.
# If any fail, reapply the patch.
```

## Reapply Patch If Needed

```bash
cd ~/openclaw

# Try clean apply
git apply .claude/patches/exec-approval-telegram-fix.patch

# If conflicts
git apply --3way .claude/patches/exec-approval-telegram-fix.patch

# If that also fails, see manual apply guide in:
# .claude/patches/EXEC-APPROVAL-FIX-RUNBOOK.md
```

## Rebuild and Restart

```bash
pnpm build

pkill -9 -f openclaw-gateway || true
nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &

# Verify
openclaw channels status --probe
ss -ltnp | rg 18789
```

## E2E Validation on Telegram

1. Send a command that requires exec approval to an agent session routed to Telegram
2. Verify the Telegram message shows:
   - `ID:` line with full 36-char UUID
   - Three separate code blocks, each tap-to-copy:
     ```
     /approve <uuid> allow-once
     ```
     ```
     /approve <uuid> allow-always
     ```
     ```
     /approve <uuid> deny
     ```
3. Tap one of the code blocks to copy, paste and send
4. Confirm: approval resolves, agent continues

## Regression Indicators

Any of these after an update = fix was overwritten:

| Signal                             | What to check                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| User reports "unknown approval id" | Gateway logs: `grep "unknown approval" /tmp/openclaw-gateway.log`                                  |
| `APPROVAL_SLUG_LENGTH = 8`         | `grep "SLUG_LENGTH = 8" src/agents/bash-tools.exec-runtime.ts`                                     |
| Old placeholder format             | `grep "Reply with:" src/infra/exec-approval-forwarder.ts`                                          |
| Test failures                      | `pnpm test -- src/gateway/exec-approval-manager.test.ts src/infra/exec-approval-forwarder.test.ts` |

## Run Regression Tests

```bash
pnpm test -- src/gateway/exec-approval-manager.test.ts src/infra/exec-approval-forwarder.test.ts
```

Expected: 29 tests pass (13 manager + 16 forwarder).

## Rollback (if fix causes issues)

```bash
# Revert only the fix files to upstream HEAD
git checkout HEAD -- \
  src/agents/bash-tools.exec-runtime.ts \
  src/gateway/exec-approval-manager.ts \
  src/gateway/server-methods/exec-approval.ts \
  src/infra/exec-approval-forwarder.ts

# Remove new test file
rm -f src/gateway/exec-approval-manager.test.ts

# Rebuild
pnpm build
```

## File Reference

| File                                                  | Role                                    |
| ----------------------------------------------------- | --------------------------------------- |
| `src/agents/bash-tools.exec-runtime.ts:91`            | `APPROVAL_SLUG_LENGTH = 36`             |
| `src/gateway/exec-approval-manager.ts:178-200`        | `findByIdOrPrefix()` method             |
| `src/gateway/server-methods/exec-approval.ts:278-318` | Resolution handler with prefix matching |
| `src/infra/exec-approval-forwarder.ts:194-205`        | Code block formatting                   |
| `src/gateway/exec-approval-manager.test.ts`           | 13 unit tests for manager               |
| `src/infra/exec-approval-forwarder.test.ts`           | 16 tests (3 new for format hardening)   |
| `.claude/patches/exec-approval-telegram-fix.patch`    | Reapplication artifact                  |
| `.claude/patches/verify-exec-approval-fix.sh`         | Quick verification script               |
| `.claude/patches/EXEC-APPROVAL-FIX-RUNBOOK.md`        | Detailed manual apply guide             |
