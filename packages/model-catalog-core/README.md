# Model catalog core

Shared model references, provider ID normalization, pricing types, inference
capabilities, and remote catalog validation for OpenClaw and catalog consumers.
The package has no Gateway or provider-plugin runtime dependency.

## Build and package locally

From a source checkout with its frozen dependencies installed:

```sh
pnpm --filter @openclaw/normalization-core build
pnpm --filter @openclaw/model-catalog-core build
mkdir -p .artifacts/model-catalog-packages
pnpm --filter @openclaw/normalization-core pack --pack-destination "$PWD/.artifacts/model-catalog-packages"
pnpm --filter @openclaw/model-catalog-core pack --pack-destination "$PWD/.artifacts/model-catalog-packages"
```

The canonical workspace builder emits ESM and declarations for each exported
entry point. Build and install both local tarballs together when testing outside
the workspace: model catalog core depends on normalization core, and neither
private package is published to the registry. Packing replaces the workspace
dependency with the normalization package's version.

Consumers import `@openclaw/model-catalog-core` or a subpath listed in
`package.json`. Use these entry points instead of importing source files from an
OpenClaw checkout. This local packaging workflow does not publish either package
or establish a public release contract.
