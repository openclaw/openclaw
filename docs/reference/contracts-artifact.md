# Immutable platform contracts artifact

Core consumes `@openclaw/contracts@0.1.0` from the committed vendored source
tree at `vendor/openclaw-contracts/`. The package is **not** declared in
`package.json` dependencies or lockfiles; platform orchestration imports the
vendored runtime and types directly. No sibling contracts checkout and no
npm/`file:` dependency graph change is required.

Approved tree SHA-256:
`9d603e69d28eb76faabb3cfce7d756103ce0163929c53ae1256278711a616e7e`

Run `pnpm verify:contracts` for a focused check. The normal build, check, and
test lifecycle hooks run the same stdlib verifier before loading contracts.
The verifier also fail-closes if `@openclaw/contracts` reappears as an npm
dependency.

When upgrading, replace the vendored tree with the newly approved package
contents, update the version and tree SHA-256 in
`scripts/verify-contracts-artifact.mjs` and this page, then re-run the focused
platform-orchestration suite.
