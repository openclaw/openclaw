---
summary: "Build an OpenClaw Node.js Single Executable Application package for container deployment"
read_when:
  - Packaging OpenClaw as a single executable with sidecar files
  - Testing plugin dependencies in an executable OpenClaw package
title: "Single Executable Build"
---

`pnpm build:sea` creates a `dist-sea/` package with an `openclaw` executable and the sidecar files OpenClaw still needs at runtime.

OpenClaw uses Node.js SEA as a trampoline, not as a full JavaScript bundle. The executable embeds a small CommonJS loader, then runs the packaged `openclaw.mjs` from the filesystem. This keeps normal Node module resolution available for OpenClaw core modules, bundled plugin entrypoints, and plugin runtime dependencies.

```bash
pnpm build:sea
dist-sea/openclaw --version
dist-sea/openclaw plugins list --json
```

For Linux container targets:

```bash
pnpm build:sea:linux-arm64
pnpm build:sea:linux-x64
```

By default, the local build links `dist-sea/node_modules` back to the checkout `node_modules` so smoke tests are fast. Use `--copy-node-modules` when preparing a portable directory:

```bash
node scripts/build-sea.mjs --copy-node-modules
```

The builder downloads the official Node.js binary for the target into `.artifacts/sea-node-cache/`, verifies it against Node's release `SHASUMS256.txt`, and uses that binary as the SEA base executable. On macOS, the generated binary is ad-hoc signed after injection.

Bundled plugin dependencies are intentionally not embedded into the SEA blob. The sidecar package preserves the npm package layout and `dist/postinstall-inventory.json`, so plugin dependency detection and repair use the same paths as a normal OpenClaw package install.
