# Vendor fs-safe on demand

Use this fallback when an fs-safe dependency problem prevents normal work.
Registry dependencies remain the default. Do not commit dependency archives,
native binaries, or generated vendor contents; this recipe creates local,
ignored working material only.

## Prepare local packages

Work in an independently owned checkout. Stop builds and tests before changing
its installation; never modify a borrowed/shared `node_modules` directory.
Identify the root pin and any separate transitive versions:

```sh
node -p "require('./package.json').dependencies['@openclaw/fs-safe']"
pnpm -r why @openclaw/fs-safe
```

Obtain a reviewed [upstream checkout](https://github.com/openclaw/fs-safe) or known-good local package for each affected
version. Follow that revision's build instructions, then copy its built package
directories into `vendor/fs-safe/<version>/`. Preserve `package.json`, exports,
JavaScript/WASM assets, licenses, and matching native packages. Inspect the
upstream native-package contract; do not assume the main package contains all
platform binaries. Do not edit `node_modules` or change native/error policy to
make a broken copy load.

## Select the local copies

Merge exact-version entries into the existing `pnpm-workspace.yaml` overrides map.
Replace the placeholders with the versions, native targets, and package
directories prepared above. Preserve unrelated entries and keep distinct fs-safe
versions distinct, including copies used by other dependencies.

```yaml
overrides:
  "@openclaw/fs-safe@<version>": file:vendor/fs-safe/<version>/core
  "@openclaw/fs-safe-<target>@<version>": file:vendor/fs-safe/<version>/<target>
```

Repeat for each affected version and its matching native packages. Leave the
source checkout's linker setting unchanged, then reconcile and verify:

```sh
pnpm install --no-frozen-lockfile
pnpm install --frozen-lockfile
pnpm build
node scripts/run-vitest.mjs src/infra/fs-safe.test.ts src/infra/fs-safe-remove.test.ts
```

Reproduce the original problem and test its caller too. If a local package needs
build-script approval, inspect its scripts and use an exact artifact rule rather
than disabling strict approval globally. Other dependencies still need their
registry or cache; this is not an offline OpenClaw installer.

This recipe applies only to the source checkout. Workspace overrides do not
carry into published packages, and the existing package-staging workflow does
not bundle the local fs-safe copies. Custom distributions need separate,
verified packaging work; this recipe does not provide it.

## Return to registry dependencies

Remove only the local overrides added for this fallback. Rerun
`pnpm install --no-frozen-lockfile` and `pnpm build`, then inspect the manifest and
lockfile diff for unrelated changes. Remove task-owned vendor contents when no
longer needed, without touching other work or installations.
