# Documentation Maintenance

Zorg MemoryDB documentation is part of the recovery surface. Keep it public-safe, current with the live DB-memory design, and useful to a future agent that may need to repair a broken install.

## Review order

1. Query structured DB rules and recent project history first.
2. Inspect recent `Zorg_MemoryDB` commits, release notes, schema changes, install changes, and recovery changes.
3. Review the public docs that describe the changed surface:
   - `README.md`
   - `CHANGELOG.md`
   - `docs/why-zorg-memorydb.md`
   - `docs/rules-and-recall.md`
   - `docs/schema-summary.md`
   - `docs/database-recovery.md`
   - `docs/root-markdown-db-first.md`
   - `docs/release-process.md`
   - `docs/install/zorg-memorydb.md`
   - `zorg/README.md`
   - `docs/releases/`
4. Update public-safe docs only. Keep private memory rows, contacts, transcripts, credentials, emails, account data, and operator-private context out of the repository.

## Clean worktree rule

When the live workspace is divergent, use a clean worktree at current `origin/main` for publication work. Do not base public docs on stale local branches unless the branch contains a reviewed public-safe change that must be ported forward.

## Verification gate

Before pushing docs or release changes:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check:docs
```

If formatting fails, run the repository formatter, inspect the diff, and rerun the gate:

```bash
corepack pnpm format:docs
git diff -- docs README.md CHANGELOG.md
corepack pnpm check:docs
```

After pushing, verify the pushed commit with GitHub Actions:

```bash
gh run list --repo StefRush2099/Zorg_MemoryDB --limit 20
gh run view --repo StefRush2099/Zorg_MemoryDB <run-id> --log-failed
```

Do not call a publication complete while required workflows for the pushed commit are queued, in progress, or failing.

## Maintenance record

Record meaningful maintenance in DB-backed memory. Do not create a workspace `memory/` directory or markdown notes as durable state.
