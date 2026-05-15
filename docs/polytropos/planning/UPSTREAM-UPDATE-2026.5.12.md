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

## Directory-level change counts (top-level)

```
   7765 src
   5604 extensions
   1007 docs
    595 scripts
    448 apps
    395 test
    390 ui
    173 vendor
    135 packages
     97 .github
     86 qa
     37 .agents
     32 skills
     10 .pi
      9 config
      6 security
      6 Swabble
      5 assets
      4 .vscode
      2 patches
      1 vitest.unit.config.ts
      1 vitest.unit-paths.mjs
      1 vitest.scoped-config.ts
      1 vitest.pattern-file.ts
      1 vitest.live.config.ts
      1 vitest.gateway.config.ts
      1 vitest.extensions.config.ts
      1 vitest.e2e.config.ts
      1 vitest.contracts.config.ts
      1 vitest.config.ts
      1 vitest.channels.config.ts
      1 vitest.channel-paths.mjs
      1 tsdown.config.ts
      1 tsconfig.projects.json
      1 tsconfig.plugin-sdk.dts.json
      1 tsconfig.oxlint.json
      1 tsconfig.json
      1 tsconfig.extensions.projects.json
      1 tsconfig.extensions.json
      1 tsconfig.core.projects.json
```
