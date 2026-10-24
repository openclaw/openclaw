---
summary: "Automatic local Git history for Knowledge vaults: what is committed, failure states, and recovery boundaries"
read_when:
  - You want to inspect or understand the Git repository inside a Knowledge vault
  - A Knowledge receipt shows git state pending or unavailable
  - You are planning backups of Knowledge data
title: "Knowledge local history"
sidebarTitle: "Local history"
---

Knowledge keeps a local Git history of each store's vault. Part of the
[Knowledge plugin](/plugins/knowledge) guide.

## Policy

Git is used whenever the `git` executable is installed and `writesEnabled` is
`true`. There is no separate opt-in. The first content checkpoint initializes
`<store>/vault/.git` if it is missing, or reuses an existing repository at exactly
that root. An enclosing repository is never adopted.

There are no remotes, fetch, pull, push, or GitHub integration, and no
credentials or network access are needed.

## Publication and checkpoints

1. A publication validates and journals its intent, then installs the record and
   any retained evidence.
2. The transaction that acknowledges the publication queues the exact changed
   bytes in `state.sqlite`.
3. Knowledge commits that batch and records the commit in the receipt.

The queue is an outbox, not a second knowledge store; Markdown stays
authoritative. Because exact snapshots are queued, a Git outage followed by more
edits does not lose intermediate versions.

A failed Git step never rolls back a publication or turns it into a conflict.
Receipts report `git.state` as `committed` (with `git.commit`), `pending`, or
`unavailable`. **Activity & issues** in the Knowledge page shows these states with
a retry control. `knowledge_resume` retries a publication's checkpoint, and
ordinary authorized scans retry waiting batches. If Git is installed later, queued
versions are committed in order. There is no background retry timer.

## What gets committed

- Each successful publication gets one commit with exactly its records and
  evidence.
- The first scan of a partition commits a baseline of its Markdown and YAML.
  Later scans group observed external edits, renames, and deletions into one
  checkpoint. Edits made between two scans cannot be reconstructed.
- Non-media originals below 100 MiB are committed as exact blobs. Larger
  originals and media stay outside automatic snapshots.
- Unrelated working-tree edits and staged content are not swept into a
  publication commit. Knowledge never checks out, resets, or overwrites working
  files.
- Commits name the Knowledge service as committer and label the actor (`agent`,
  `operator`, or external observation). These labels are coarse provenance, not
  authenticated identities.
- Hooks, clean/smudge filters, signing, and network commands are not used. User
  and global Git configuration are not changed.

`vault.json`, recovery files under `.knowledge-history/`, and SQLite are not
committed.

## Failures and recovery

Repository problems are not treated as missing Git. Permissions, locks, a
detached HEAD, linked worktree `.git` files, malformed repositories, or an
in-progress merge leave visible `pending` checkpoints. Fix the repository and
retry. A stale lock is never removed automatically. Finish manual merges or
rebases before automatic history can continue, and run only one Gateway against a
vault.

Local Git is content history, not a full backup. Keep the registry,
`state.sqlite`, and the vault together. Deleting or replacing `.git` is not a
restore workflow.

<Warning>
The repository covers the whole vault, including every conversation partition.
Plugin access checks do not filter it. Do not share the `.git` directory as if
it were scoped.
</Warning>
