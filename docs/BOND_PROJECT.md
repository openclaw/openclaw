# BOND Project (MaxBot Security Hardening)

Purpose: make MB powerful but fail-safe, with owner-first control and lockout-proof recovery.

## Phase 1 (Started)

- [x] Fail-closed upstream sync (`scripts/mb-sync-upstream.sh`)
- [x] Protected-file manifest (`scripts/mb-sync-protected-files.txt`)
- [x] Master key recovery scripts (`scripts/mb-master-key.sh`, `scripts/mb-master-key-restore.sh`)
- [ ] Token-only approval enforcement at broker layer
- [ ] Lane 1 / Lane 2 credential separation
- [ ] Kill switch hardening (disable bridge + revoke credentials in one action)

## Operating Rules

1. No union auto-merge for unprotected conflicts.
2. No plaintext approvals for sensitive actions.
3. Owner lane always has final authority.
4. Every critical action must be reversible.

## One-command updater

```bash
bash scripts/mb-sync-upstream.sh --deploy
```

If it fails, live branch remains unchanged and backup anchor branch is printed.

## Rollback (manual)

Use the backup branch printed by the sync script:

```bash
git checkout <your-branch>
git reset --hard <backup-branch>
```
