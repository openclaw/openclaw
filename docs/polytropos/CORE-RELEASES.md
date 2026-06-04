# Polytropos Core Releases

## Purpose

Stage and activate versioned Polytropos core releases from a valid release branch.

## Definitions

- **Release branch:** `release/YYYY.M.D`
- **Release tag:** `vYYYY.M.D+poly.N`
- **Staging:** download the CI-built tarball into the authoritative release store, update `previous.tgz` / `current.tgz`, install globally, and run the bundled deps helper.
- **Activation:** restart/reload the gateway so the running process uses the newly installed version.

## Authoritative release store

- `~/polytropos/releases/v<version>+poly.<N>.tgz` — immutable versioned release tarballs
- `~/polytropos/releases/current.tgz` — symlink to the staged tarball
- `~/polytropos/releases/previous.tgz` — symlink to the rollback tarball

## Canonical release flow

1. Work from a valid `release/YYYY.M.D` branch.
2. Run the release script.
3. The script creates/pushes the next `v<version>+poly.<N>` tag automatically.
4. GitHub Actions builds the tarball artifact.
5. The script waits for CI, downloads the artifact, stages it, installs it globally, and runs the bundled deps helper.
6. Restart/reload the gateway to activate it.

## Canonical command

```bash
node scripts/polytropos-release.mjs release
```

## Optional overrides

```bash
node scripts/polytropos-release.mjs release --tag v2026.4.1+poly.24
node scripts/polytropos-release.mjs release --workflow polytropos-build-pack.yml
```

## Rules

- The release script must run from a branch matching `release/YYYY.M.D`.
- `origin/main` is legacy and should not be used for release work.
- Versioned tarballs in `~/polytropos/releases/` are immutable.
- Never overwrite `current.tgz` / `previous.tgz` via `cp`; they are symlinks.

## Activation

Activation is intentionally separate from staging.
After staging succeeds, restart/reload the gateway using the correct environment-specific procedure.

## Rollback

Rollback uses the same model:
1. point `current.tgz` back at the desired prior version (or restage it properly)
2. reinstall if needed
3. restart/reload the gateway

See also:
- [`../../POLYTROPOS.md`](../../POLYTROPOS.md)
- [`./UPDATE-PROCEDURE.md`](./UPDATE-PROCEDURE.md)
