# Upstream Update Summary: v2026.4.1 → v2026.5.12

This document summarizes what we would incorporate if we update the Polytropos fork from upstream `v2026.4.1` to upstream `v2026.5.12`.

## Target upstream version

- Current base in fork: `v2026.4.1`
- Proposed upstream target: `v2026.5.12`

## High-level change surface (directory-level)

Top-level directories touched between the tags were dominated by:

- `src/`
- `docs/`
- `scripts/`
- `.github/`
- `packages/`

(See the directory-count output from `git diff --name-only v2026.4.1..v2026.5.12 | awk -F/ '{print $1}' ...`.)

## Notable areas likely impacted

Without enumerating every commit/file, expect updates in:

- Plugin loading / tooling plumbing (under `src/`)
- Release + packaging scripts (`scripts/`, `.github/`)
- Documentation changes (`docs/`)

## Merge conflict outlook

A dry-run merge was performed locally (`git merge --no-commit --no-ff v2026.5.12` then aborted).

Result:

- Conflicts: **TBD** (see the conflict list section below)

### Conflict list (if any)

If conflicts were detected, they would appear in `git diff --name-only --diff-filter=U`.

## Next steps

1. Decide whether we are targeting `v2026.5.12` specifically or the newest upstream tag.
2. If proceeding, follow `docs/polytropos/CORE-RELEASES.md` update procedure.
3. After merge:
   - run the plugin verification gates
   - run `openclaw doctor`
   - validate release workflow
