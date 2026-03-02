---
name: mb-upstream-sync
description: "Sync MaxBot with the latest upstream OpenClaw release. Pulls OC updates, auto-resolves conflicts, preserves MB security layer. Use when Dave says 'new OC update', 'sync upstream', or 'update MaxBot'."
metadata: { "openclaw": { "emoji": "🔄", "requires": { "bins": ["git", "pnpm", "python3"] } } }
---

# MaxBot Upstream Sync

Fetches and merges the latest upstream OpenClaw commits into MaxBot while preserving all MB customisations.

## STRICT RULES (never deviate)

1. **Run the script — do not interpret it.** All merge decisions are hardcoded in `scripts/mb-sync-upstream.sh`. MB does not decide what gets kept or replaced.
2. **Report output verbatim.** Do not summarise, filter, or editorially comment on what was merged.
3. **Do not re-run the script on your own initiative.** Only run it when Dave explicitly asks.
4. **If the script exits non-zero**, paste the full error output and wait for Dave's instruction. Do not attempt to fix conflicts yourself outside the script.
5. **Do not modify `scripts/mb-sync-upstream.sh`** unless Dave explicitly asks you to. That file is the decision layer — not yours.

## Trigger phrases

- "new OC update", "OC update", "upstream update"
- "sync MaxBot", "update MaxBot", "pull OC changes"
- "run the sync", "do the merge"

## Execution

```bash
bash scripts/mb-sync-upstream.sh 2>&1
```

For a preview with no changes:

```bash
bash scripts/mb-sync-upstream.sh --dry-run 2>&1
```

## What the script does (for your reference only)

1. Pre-flight: checks clean working tree, no ongoing merge
2. Fetches upstream OC `main`
3. Merges with `--no-commit` so it can validate first
4. Auto-resolves conflicts:
   - MB-protected files → always keeps MB version
   - Other conflicts → union strategy (keeps both sides' additions)
   - Unresolvable → aborts and reports clearly
5. Fixes lint errors automatically (unused imports, duplicates)
6. Commits with standard message
7. Reports result

## If the script needs a manual fix

Paste the script's error output to Dave exactly as-is. Do not attempt to resolve git conflicts or modify files to work around the script — that would bypass the security contract.
