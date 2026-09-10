---
summary: "Scaffold, build, validate, and pack an OpenClaw plugin with `openclaw plugins init`"
title: "Author plugins"
read_when:
  - You want to scaffold a tool, feature, or provider plugin
  - You need the `plugins build`, `validate`, or `pack` contract
---

This page covers the authoring commands: `plugins init`, `plugins build`,
`plugins validate`, and `plugins pack`, plus the tool, feature, and provider
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

`plugins build` imports the built entry, reads its static tool metadata, writes
`openclaw.plugin.json`, and keeps `package.json`'s `openclaw.extensions` aligned.
`plugins validate` checks that the generated manifest, package metadata, and
current entry export still agree. Pass `--json` for a machine-readable
validation result. See [Tool Plugins](/plugins/tool-plugins) for the full
authoring workflow.

The scaffold writes TypeScript source but generates metadata from the built
`./dist/index.js` entry, so the workflow also works with the published CLI. Use
`--entry <path>` when the entry is not the default package entry. Use
`plugins build --check` in CI to fail when generated metadata is stale without
rewriting files.

### Feature scaffold and artifacts

Use `--type feature` for a typed backend operation, agent tool, native page,
and composer replacement. Run `npm install`, `npm run build`, and
`npm run validate` in the generated project. Its browser source is declared in
`package.json.openclaw.controlUi`; `plugins build` writes immutable bundled
assets and their manifest declaration.

Plugin APIs are [experimental](/plugins/sdk-overview#api-stability). To load the
scaffold's native browser UI, enable **Settings → Labs → Custom plugin UI**, then
restart the Gateway and reload the browser. See
[Enable custom plugin UI](/plugins/feature-plugins#enable-custom-plugin-ui).

`plugins pack` validates a built project, bundles its backend dependencies, and
writes an archive containing compiled code and UI with no install scripts or
runtime package dependencies. `--json` returns its absolute path, SHA-256 digest,
and exact `plugin_activate_artifact` request. The output file must not exist.
The default filename is `<plugin-id>.tgz` in the project root, with `/` replaced
by `__` for scoped ids (for example, `@author__tools.tgz`). Use `--out` to choose
another path. Packing follows the package's runtime entry selection, including
`runtimeExtensions`, and bundles a declared setup entry separately. Source/runtime
entry paths are rewritten to the compiled files included in the archive.
See [Feature plugins](/plugins/feature-plugins) for activation approval, reload,
view lifecycle, and recovery.

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
`openclaw plugins build`/`validate`; those commands are for the tool
scaffold's generated-metadata path.

Before publishing, replace the placeholder API base URL, model catalog, docs
route, credential text, and README copy with real provider details. Use the
generated README for first-time ClawHub publishing and trusted-publisher setup.
