# Immutable platform contracts artifact

Core consumes `@openclaw/contracts@0.1.0` from the committed vendored source
tree at `vendor/openclaw-contracts/`. The package is **not** declared in
`package.json` dependencies or lockfiles; platform orchestration imports the
vendored runtime and types directly. No sibling contracts checkout and no
npm/`file:` dependency graph change is required.

Approved tree SHA-256:
`f7faaf55a6c1c542116df0c32d4fa44ead8dbb3742eb0c7736915eb56972ab76`

Run `pnpm verify:contracts` for a focused check. The normal build, check, and
test lifecycle hooks run the same stdlib verifier before loading contracts.
The verifier also fail-closes if `@openclaw/contracts` reappears as an npm
dependency.

When upgrading, replace the vendored tree with the newly approved package
contents, update the version and tree SHA-256 in
`scripts/verify-contracts-artifact.mjs` and this page, then re-run the focused
platform-orchestration suite.
