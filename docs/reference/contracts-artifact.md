# Immutable platform contracts artifact

Core consumes `@openclaw/contracts@0.1.0` from the committed
`vendor/packages/openclaw-contracts-0.1.0.tgz` artifact. `package.json` and
`pnpm-lock.yaml` use only the repository-relative URL
`file:vendor/packages/openclaw-contracts-0.1.0.tgz`; no sibling contracts
checkout is required.

Approved SHA-256:
`5863c0b19a6ecb3c552392bac2074dd72ee67a5a8dc0061760a1b0257c62465a`

Approved pnpm integrity:
`sha512-r3NzvO9DhbxcRzeCvDobQRCjKwO5sp4hlrvGXmSMk6hrnNOkHjJ4FUaAqbOqPiqVjU9S2Ft5FLgiew9DEE5hvA==`

Run `pnpm verify:contracts` for a focused check. The normal build, check, and
test lifecycle hooks run the same stdlib verifier before loading contracts.
`pnpm-workspace.yaml` excludes only this exact package/version from
`minimumReleaseAge`: pnpm otherwise queries npm registry metadata even for the
local `file:` artifact and receives 404. Published dependencies remain subject
to the workspace release-age policy; artifact bytes and lock integrity remain
enforced by the verifier.
When upgrading, copy the newly approved versioned tarball into
`vendor/packages`, update the dependency and lockfile together, then update the
version and SHA-256 in `scripts/verify-contracts-artifact.mjs` and this page.

E11.4 verification used a minimal isolated consumer install/import proof plus
lockfile/artifact consistency on 2026-07-18, and the focused
platform-orchestration suite passed 5 files / 17 tests. The repository-pinned
full frozen dependency installation also completed successfully. Core remains
**Partial**, however, because the active full canonical post-implementation
repository gate has not completed and remains uncredited. Git promotion, push,
release, and deployment are **Not Performed**.
