---
summary: "Inspect plugin and dependency runtime hazards without activating the plugin"
title: "Plugin runtime compatibility"
read_when:
  - You are preparing a plugin for Node, Bun, or a compiled desktop host
  - An install reports a runtime compatibility warning
---

OpenClaw reports runtime compatibility hazards after a code plugin's production
dependencies have been materialized and before activation. The same static
inspection is available to plugin authors without importing or running their
plugin:

```bash
openclaw plugins lint --root ./my-plugin
openclaw plugins lint --root ./my-plugin --json
```

Install the plugin's dependencies first. The inspection follows materialized
production, optional, and peer dependencies, excluding the host's `openclaw`
peer and development dependencies. Each warning identifies its package name,
version, source file, line, and rule. Tests, fixtures, declarations, and nested
`node_modules` directories are not scanned as package source; each resolved
runtime dependency is inspected under its own package identity.

In JSON output, `complete` describes coverage of the selected materialized
package manifests and source files. It does not say that the plugin is compatible
with the host. `scannedPackages` and `scannedFiles` are inspection counts.
Missing required dependencies or peers and malformed dependency metadata make
coverage incomplete. Optional dependencies and peers explicitly marked optional
can be absent. An absent `openclaw` dependency does not produce a missing-dependency
warning: the host-link owner supplies it after install checks. Existing
OpenClaw dependency directories still undergo the normal admission checks.

## What the warnings mean

| Rule                      | Hazard                                                                               | Prefer                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `builtin-patch`           | Replacing or deleting an existing built-in member, or changing a protected prototype | Owned wrappers, subclasses, and instance metadata                                   |
| `host-patch`              | Changing process-wide functions or Node module exports                               | `api.logger`, local fetch wrappers, provider transport hooks, and diagnostic events |
| `loader-patch`            | Replacing module loaders or module-resolution hooks                                  | The host plugin loader and documented SDK entrypoints                               |
| `runtime-code-generation` | Calling `eval`, `Function`, or Node VM compilation APIs                              | Emitted JavaScript or parsing the relevant language                                 |
| `scan-incomplete`         | A read, parse, symlink, or inspection limit prevented complete source coverage       | Inspect the named files or package separately                                       |

The analyzer resolves lexical receivers and simple constant aliases. A plugin's
own class named `Array`, a read of `Array.prototype.push`, and an instance's
`url` property are different from replacing a host built-in. Ordinary new
properties on extensible built-ins are not treated as immutable-member writes.

## Warnings and host qualification

Warnings do **not** block installation, require approval, or change
`security.installPolicy`. They are compatibility diagnostics, separate from
operator security policy and the optional `before_install` hook. Static source
inspection cannot establish whether an optional branch executes, whether a
browser-side function is serialized into another realm, or what code a string
will produce. Blocking on these observations would reject working plugins.

Process-wide patches can conflict on Node and Bun when multiple owners install
and restore wrappers. In a compiled host, immutable built-in writes can fail,
and other global writes depend on which writers the actual host retained.
Runtime module hooks do not intercept imports resolved during compilation.
Code loaded after compilation is not made native by the host's build mode.

Qualify activation, SDK calls, transitive imports, disablement, and the supported
reload lifecycle against each actual host runtime. A warning-free report is
not a compatibility certificate: computed aliases, generated strings, native
addons, dormant branches, and host-image requirements need behavioral proof.
The inspection does not install packages, fetch code, execute lifecycle scripts,
or run an activation test.
