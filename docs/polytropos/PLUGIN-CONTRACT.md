# Polytropos Plugin Contract

This document defines the _codified_ expectations for plugins built in `polytropos-plugins` and loaded by OpenClaw/Polytropos.

This is a **permanent** contract (not planning notes). When reality diverges from this contract, we either:

- update tooling to conform, or
- explicitly revise this contract and record the reason.

---

## Terms

- **Plugin artifact root**: `polytropos-plugins/dist/plugins/<pluginId>/`
- **Manifest**: `openclaw.plugin.json`
- **Plugin root**: the directory OpenClaw is pointed at when loading a plugin.

---

## Artifact layout (required)

A packaged plugin artifact is produced at:

`polytropos-plugins/dist/plugins/<pluginId>/`

It must contain:

- `dist/openclaw.plugin.json`
- `dist/index.js` (or whatever `manifest.entry` points to)

---

## Plugin root rule (required)

**Plugin root is the directory that contains the manifest (`openclaw.plugin.json`).**

In our artifact layout that means:

`polytropos-plugins/dist/plugins/<pluginId>/dist/`

Deploy tooling must always point OpenClaw at _this_ directory (the manifest directory), not the artifact root.

---

## Deployment contract (codified)

We never manually guess the right folder.

`scripts/deploy-plugin.mjs` must:

1. locate the manifest
2. validate `manifest.id === <pluginId>`
3. validate `manifest.entry` exists
4. deploy the **manifest directory** as plugin root

### Runtime dependencies (external extensions)

External extensions are deployed to:

`~/.openclaw/extensions/<pluginId>`

If an extension’s `package.json` declares `dependencies` / `optionalDependencies`, then **deploy-prod (copy)** must materialize runtime deps so the deployed extension is runnable.

Current rule (implemented after the browser-cloud incident):

- in copy mode, after copying, run:
  - `npm install --omit=dev --no-save --silent --ignore-scripts`
  - with `cwd=~/.openclaw/extensions/<pluginId>`

Rationale:

- prod-only (`--omit=dev`)
- no lifecycle scripts (`--ignore-scripts`)
- no lockfile coupling (`--no-save`)

Symlink/dev mode must **not** mutate the source tree.

---

## Verification gates (codified)

Before enabling a migrated plugin:

- `pnpm verify:plugin <pluginId>` (artifact layout gate)
- `pnpm verify:doctor-plugin <pluginId>` (OpenClaw doctor gate)

These gates must remain fast and deterministic.

---

## Known warnings / required follow-ups

If you see warnings like:

- `plugin id mismatch (manifest uses "…", entry hints "dist")`

Treat that as a bug:

- either deploy tooling is pointing at the wrong root,
- or manifest rewrite is incorrect,
- or loader expectations differ from this contract.

We should either fix tooling/loader or update this doc with the new canonical rule.
