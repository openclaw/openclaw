---
summary: "package.json openclaw source and runtime entry fields and their resolution order"
title: "Plugin SDK package entries"
sidebarTitle: "Package entries"
read_when:
  - You are declaring extensions, setupEntry, or their runtime peers
  - You need the built-JavaScript peer resolution order
---

How installed plugins point `package.json` at source and built entries, and
the order OpenClaw resolves them in. Part of the
[Plugin entry points](/plugins/sdk-entrypoints) reference.

## Package entries

Installed plugins point `package.json` `openclaw` fields at both source and
built entries:

```json
{
  "openclaw": {
    "extensions": ["./src/index.ts"],
    "runtimeExtensions": ["./dist/index.js"],
    "setupEntry": "./src/setup-entry.ts",
    "runtimeSetupEntry": "./dist/setup-entry.js"
  }
}
```

- `extensions` and `setupEntry` are source entries, used for workspace and git
  checkout development.
- `runtimeExtensions` and `runtimeSetupEntry` select the built entries instead
  of the corresponding source entries.
- `runtimeExtensions`, when present, must match `extensions` in array length
  (entries pair positionally). `runtimeSetupEntry` requires `setupEntry`.
- If a `runtimeExtensions`/`runtimeSetupEntry` artifact is declared but
  missing, installation fails and discovery reports a packaging error for that
  entry; OpenClaw does not silently fall back to source.
- Without an explicit runtime entry, package discovery through
  `plugins.load.paths` or global roots looks for matching JavaScript peers under
  `dist/` first, then beside the TypeScript source entry. For `src/` entries,
  it checks both flattened `dist/` output and output retaining `dist/src/`.
  At each location, `.mts` prefers `.mjs` and `.cts` prefers `.cjs`; `.ts` and
  `.tsx` try `.js`, `.mjs`, then `.cjs`. Installation, discovery, setup, runtime
  loading, and published-package verification use the same candidate order.
- A `plugins.load.paths` entry that resolves inside the host's own bundled
  plugin tree is discovered as that bundled plugin, so it keeps the bundled
  entry point and bundled provenance whether or not compiled output exists
  beside the source. Selecting a bundled plugin's own path never reclassifies it.
- Package installation and managed installed-package discovery require compiled
  output for TypeScript extension and setup entries. Missing compiled output is
  a packaging error, not a reason to fall back to TypeScript.
- Trusted local/source development paths can use TypeScript when no runtime
  entry is declared. These include workspace plugins, explicit local load paths,
  untracked local plugin directories, and linked source checkouts. Workspace
  discovery keeps the source entry rather than inferring built peers.
- All entry paths must stay inside the plugin package directory. Runtime
  entries and inferred built-JS peers do not make an escaping `extensions` or
  `setupEntry` source path valid.
