## Update flow

1. Fetch latest upstream tags/branches.
2. Choose the target upstream release tag (for example `upstream/v2026.6.1` or `v2026.6.1`).
3. Create a new Polytropos release branch **from that upstream release tag**:
   - `release/YYYY.M.D`
4. Merge `master` into that new release branch.
5. Resolve conflicts on the release branch.
6. Build and validate on the release branch.
7. Cut a Polytropos release tag from the release branch.

### Canonical branch creation example

```bash
git fetch --tags upstream origin
git checkout -b release/2026.6.1 v2026.6.1
git merge origin/master
```

Notes:
- Do **not** start an update from `origin/main`; that branch is legacy.
- Do **not** merge the upstream tag directly into `master`.
- `master` is the long-lived fork branch; each target version gets its own `release/YYYY.M.D` branch.


# Polytropos Core Update Procedure (Upstream → Fork)

**Definition:** An **update** means merging in a newer upstream OpenClaw release tag into `openclaw-polytropos`, then following the standard core **release + activation** procedure.

See also:

- Release mechanism: [`docs/polytropos/CORE-RELEASES.md`](./CORE-RELEASES.md)

## Inputs

- Upstream OpenClaw tag: `<upstreamTag>` (example: `v2026.5.10`)

## Procedure

### 1) Sync upstream

- Fetch upstream tags.
- Identify the upstream tag to update to.

### 2) Integrate upstream tag into the fork

Always integrate upstream via a **recursive merge** (no rebases).

**Requirement:** the merge must complete successfully and leave the repo in a clean state (no conflicts, no half-merged index).

Output of this step: `openclaw-polytropos` `main` contains upstream `<upstreamTag>` plus fork commits.

### 3) Release

After the merge is successfully completed, follow the standard **release + activation** procedure:

- [`docs/polytropos/CORE-RELEASES.md`](./CORE-RELEASES.md)

## Notes

- Updates are infrequent and should be deliberate.
- Releases may be more frequent (e.g. multiple `-poly.N` tags) even when upstream doesn’t move.
