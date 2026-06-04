# Polytropos Update Procedure

## Purpose

Update Polytropos to a newer upstream OpenClaw release while preserving the fork's long-lived changes from `master`.

## Canonical flow

1. Fetch upstream and origin refs.
2. Choose the target upstream release ref (`upstream/vYYYY.M.D` or `upstream/release/YYYY.M.D`).
3. Create a new Polytropos release branch from that upstream release:
   - `release/YYYY.M.D`
4. Merge `origin/master` into the new release branch.
5. Resolve conflicts on the release branch.
6. Build and validate on the release branch.
7. Stage/cut a Polytropos release tag from the release branch.

## Canonical example

```bash
git fetch --tags upstream origin
git checkout -b release/2026.6.1 v2026.6.1
git merge origin/master
```

## Rules

- Do **not** start update work from `origin/main`; it is legacy.
- Do **not** merge an upstream release tag directly into `master`.
- `master` is the long-lived fork branch.
- Each target upstream version gets its own `release/YYYY.M.D` branch.

## After the merge

Once the release branch builds cleanly and behaves correctly:
- use the core release procedure to cut the next `vYYYY.M.D+poly.N` tag
- stage/install that release from the same release branch

See also:
- [`../../POLYTROPOS.md`](../../POLYTROPOS.md)
- [`./CORE-RELEASES.md`](./CORE-RELEASES.md)
