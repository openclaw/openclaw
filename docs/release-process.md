# Release Process

Use curated Zorg MemoryDB release notes when a public-safe structural, runtime, schema, recall, rule, install, backup, or recovery change needs to be reproducible outside the live chat transcript.

## When to create a release note

Create or update `docs/releases/vX.Y.Z.md` for meaningful changes such as:

- schema, table, view, function, trigger, index, or materialized-view changes
- recall routing, ranking, hint, semantic edge, query-observation, or logic-rule changes
- installer, clean-install, existing-upgrade, or runtime package changes
- backup, recovery, drill, restore, or DB-only memory enforcement changes
- public-safe rule changes that affect future agent behavior

Small typo fixes may stay in normal docs without a semantic tag. Do not create a release note for private data updates.

## Versioning

Use the next `v1.2.x` MemoryDB documentation release for public-safe MemoryDB maintenance unless the package release process has moved to a newer documented scheme. Tag only when release criteria are actually met:

1. public-safe release note exists
2. changed docs/scripts/templates are committed
3. local documentation gate passes
4. push succeeds
5. GitHub Actions evidence for the pushed commit is successful

## Public-safety checklist

Before commit, inspect the diff for:

- database dumps or row exports
- contacts, phone numbers, emails, transcripts, credentials, tokens, cookies, or account data
- private operator context or private strategy
- absolute private backup contents rather than structural backup locations and commands

Public docs may mention expected local rollback locations and separately approved private recovery concepts, but must not publish live backup files, private database rows, contacts, transcripts, credentials, or private memory.

## Local gate

Use the repository package manager through Corepack:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check:docs
```

If docs formatting changes are required:

```bash
corepack pnpm format:docs
git diff
corepack pnpm check:docs
```

## GitHub verification

After push, check Actions for the pushed commit:

```bash
gh run list --repo StefRush2099/Zorg_MemoryDB --limit 20
gh run view --repo StefRush2099/Zorg_MemoryDB <run-id> --log-failed
```

Repair only the exact failed scope if a required workflow fails.
