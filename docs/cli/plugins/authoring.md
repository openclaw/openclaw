---
summary: "Scaffold, build, validate, and pack an OpenClaw plugin with `openclaw plugins init`"
title: "Author plugins"
read_when:
  - You want to scaffold a tool, feature, or provider plugin
  - You need the `plugins build`, `validate`, or `pack` contract
---

This page covers the authoring commands: `plugins init`, `plugins build`,
`plugins validate`, `plugins lint`, and `plugins pack`, plus the tool, feature, and provider
scaffolds they generate.

## Author

```bash
openclaw plugins init stock-quotes --name "Stock Quotes"
cd stock-quotes
npm run plugin:build
npm run plugin:validate
```

`plugins init` creates a minimal TypeScript tool plugin by default. The first
argument is the plugin id; `--name` sets the display name. OpenClaw uses the
id for the default output directory and package naming. Tool scaffolds use
`defineToolPlugin` and generate `package.json` scripts `plugin:build` and
`plugin:validate` that build then call `openclaw plugins build`/`validate`.

`plugins build` and `plugins validate` require the generated authoring metadata
exposed by tool and feature entries. Build imports the built entry, reads that
metadata, writes `openclaw.plugin.json`, and keeps `package.json`'s
`openclaw.extensions` aligned. Validate checks that the generated manifest,
package metadata, and current entry export still agree. Pass `--json` for a
machine-readable validation result. Ordinary plugins that author their own
manifest use their own build and validation workflow; they can still use
[`plugins pack`](#pack-a-plugin). See [Tool Plugins](/plugins/tool-plugins) for the
generated-metadata workflow.

Authoring metadata must be regular files containing valid UTF-8 JSON. Symlinks to
regular files are supported; pipes and other special files are rejected before reading.

`plugins lint --root <path>` inspects a plugin and its materialized runtime
dependencies without importing plugin code or reading operator configuration.
Use `--json` for structured compatibility warnings. Findings do not block installs;
see [Runtime compatibility](/plugins/runtime-compatibility) for scope and limits.

The scaffold writes TypeScript source but generates metadata from the built
`./dist/index.js` entry, so the workflow also works with the published CLI. Use
`--entry <path>` when the entry is not the default package entry. Use
`plugins build --check` in CI to fail when generated metadata is stale without
rewriting files.

Tool and provider scaffolds compile `src/index.ts` and its imported modules into
`dist`, leaving independent test files out of the package. Feature scaffolds also
include their separate browser entry in TypeScript checks. All scaffolds pin
TypeScript 7.0.2 and set `rootDir` to `src`, keeping the compiled entry at
`dist/index.js`.

TypeScript compilation leaves backend package imports such as `typebox` intact.
`plugins build` generates backend metadata; it does not bundle backend dependencies.
Use `plugins pack` for a bundled import archive, or add bundling to your project's
own build when a linked installation loads its `dist/` files directly.

### Feature scaffold and artifacts

Use `--type feature` for a typed backend operation, agent tool, native page,
and composer replacement. Run `npm install`, `npm run build`, and
`npm run validate` in the generated project. Its browser source is declared in
`package.json.openclaw.controlUi`; `plugins build` writes immutable bundled
assets and their manifest declaration.

Plugin APIs are [experimental](/plugins/sdk-overview#api-stability). The
scaffold’s native browser UI is available by default once the plugin is enabled;
there is no Labs opt-in. Existing advanced opt-outs remain honored. See
[Enable custom plugin UI](/plugins/feature-plugins#enable-custom-plugin-ui).

### Provider scaffold

```bash
openclaw plugins init acme-models --name "Acme Models" --type provider
cd acme-models
npm install
npm run build
npm test
npm run validate
```

Provider scaffolds create a generic OpenAI-compatible model provider plugin
with API-key auth plumbing, a `npm run validate` script that runs
`clawhub package validate`, ClawHub package metadata, and a manually
dispatched GitHub Actions workflow for future trusted publishing via GitHub
OIDC. Provider scaffolds do not generate skills and do not use
`openclaw plugins build`/`validate`; those commands are for tool and feature
generated-metadata workflows.

Before publishing, replace the placeholder API base URL, model catalog, docs
route, credential text, and README copy with real provider details. Use the
generated README for first-time ClawHub publishing and trusted-publisher setup.

## Pack a plugin

`plugins pack` accepts tool and feature entries with generated authoring metadata,
and ordinary native plugins with an authored `openclaw.plugin.json` and runtime
registration entry. Generated-metadata plugins still undergo the strict metadata
checks used by `plugins validate`; packing does not regenerate a stale manifest.
Install `esbuild` in the plugin project's development dependencies, then pack the
built project:

```bash
npm install --save-dev esbuild
openclaw plugins pack --root . --out ./my-plugin.tgz --json
```

Packing bundles backend dependencies such as TypeBox while leaving Node builtins
and host `openclaw` SDK imports external. The archive contains compiled code,
the manifest, and declared compiled UI, with no install scripts or runtime package
dependencies. Packing follows the package's runtime entry selection, including
`runtimeExtensions`, and bundles a declared setup entry separately. Source/runtime
entry paths are rewritten to the compiled files included in the archive.

The artifact must have one backend entry. Module-relative runtime resources and
opaque dynamic loaders remain unsupported; use literal imports and embed resources,
or use the normal package-install flow. See the full
[artifact limits](/plugins/feature-plugins#approve-an-agent-built-artifact), including
restrictions on `import.meta`, `__dirname`, `__filename`, and `require.resolve`.

`--json` returns the archive's absolute path, SHA-256 digest, and exact
`plugin_activate_artifact` request. The output file must not exist. Without `--out`,
the filename is `<plugin-id>.tgz` in the project root, with `/` replaced by `__`
for scoped ids (for example, `@author__tools.tgz`). Packing does not rewrite the
project's `dist/` output or change an existing linked installation. To bundle the
backend files loaded from a linked `dist/`, add that step to the project's own build.
See [Feature plugins](/plugins/feature-plugins) for activation approval, reload,
view lifecycle, and recovery.
