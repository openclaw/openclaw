---
summary: "`plugins inspect`, `plugins doctor`, and `plugins registry` for plugin state, load failures, and the cold registry"
title: "Inspect and diagnose plugins"
read_when:
  - You want a plugin's identity, capabilities, hooks, or runtime registrations
  - You are debugging a plugin load failure or a stale plugin registry
---

This page covers the read-only diagnostic commands: `openclaw plugins inspect`,
`openclaw plugins doctor`, and `openclaw plugins registry`.

## Inspect

```bash
openclaw plugins inspect <id>
openclaw plugins inspect <id> --runtime
openclaw plugins inspect <id> --json
openclaw plugins inspect --all
```

Inspect shows identity, load status, source, manifest capabilities, policy flags, diagnostics, install metadata, bundle capabilities, and any detected MCP or LSP server support without importing plugin runtime by default. JSON output includes the plugin manifest contracts, such as `contracts.agentToolResultMiddleware` and `contracts.trustedToolPolicies`, so operators can audit trusted-surface declarations before enabling or restarting a plugin. Add `--runtime` to load the plugin module and include registered hooks, tools, commands, services, gateway methods, and HTTP routes. Runtime inspection reports missing plugin dependencies directly; installs and repairs stay in `openclaw plugins install`, `openclaw plugins update`, and `openclaw doctor --fix`.

Default human inspection uses `enabled`, `disabled`, or `error` status labels,
matching `plugins list`. It describes the metadata snapshot; it does not claim
that a plugin module was imported. With `--runtime`, successful runtime inspection
uses `loaded`. JSON retains the underlying registry status and separate `imported` field.

For multi-entry packages, inspecting any child shows the shared package install metadata. `inspect --all --json` includes that same record for each child. If package ownership is missing or ambiguous, inspection omits install metadata rather than attributing an unrelated install record.

Plugin-owned CLI commands are usually installed as root `openclaw` command groups, but plugins may also register nested commands under a core parent such as `openclaw nodes`. After `inspect --runtime` shows a command under `cliCommands`, run it at the listed path; for example a plugin that registers `demo-git` can be verified with `openclaw demo-git ping`.

Each plugin is classified by what it actually registers at runtime:

| Shape               | Meaning                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `plain-capability`  | exactly one capability type (e.g. a provider-only plugin)         |
| `hybrid-capability` | more than one capability type (e.g. text + speech + images)       |
| `hook-only`         | only hooks, no capabilities, tools, commands, services, or routes |
| `non-capability`    | tools/commands/services but no capabilities                       |

See [Plugin shapes](/plugins/architecture#plugin-shapes) for more on the capability model.

<Note>
The `--json` flag outputs a machine-readable report suitable for scripting and auditing. `inspect --all` renders a fleet-wide table with shape, capability kinds, compatibility notices, bundle capabilities, and hook summary columns. `info` is an alias for `inspect`.

Global discovery diagnostics go to stderr, including with `--json`. This explains partial inventory when workspace discovery has no selected system owner, even when no plugins are found. Plugin-specific diagnostics stay in each report. Policy fields use the same case-insensitive plugin ID matching as runtime configuration; the reported plugin ID retains its declared spelling.
</Note>

SDK import failures appear in the existing plugin error output and Doctor's
plugin diagnostics. The diagnostic names the plugin, imported
`openclaw/plugin-sdk/*` seam, running core version, and build version when known.
For an official plugin, run `openclaw plugins update <id>` and restart the Gateway.
If the error identifies a nested SDK, the plugin bundles an incompatible
OpenClaw SDK; update the plugin or contact its author.

JSON diagnostics may include `code: "sdk-incompatible"` and an optional
`sdkCompatibility` object with `seam`, `coreVersion`, `builtWithOpenClawVersion`
(when known), and `nestedSdk`. Existing diagnostics without these fields remain
valid. Model errors point to runtime inspection without including raw loader
errors.

## Doctor

```bash
openclaw plugins doctor
openclaw plugins doctor --json
```

`doctor` reports plugin load errors, manifest/discovery diagnostics, compatibility notices, and stale plugin config references such as missing plugin slots. It loads plugin modules without activating plugins and does not query the running Gateway. When these local checks pass, it prints `Plugin discovery, module loading, compatibility, and configuration checks passed. Run "openclaw health" to check the running Gateway, including runtime quarantines and fallbacks.` The [health command](/cli/health) reads current runtime quarantine and fallback state from the Gateway. If stale config remains but the install tree is otherwise healthy, the summary says so instead of implying full plugin health.

With `--json`, the same discovery, compatibility, and configuration diagnostics
are returned as one machine-readable object.

Doctor waits for its inspection registration resources to be released before
printing the report and setting the diagnostic exit status. Cleanup failures
produce a command error instead of a successful report. Running Gateway
registrations are not disposed by this inspection.

If a configured plugin is present on disk but blocked by the loader's path-safety checks, config validation keeps the plugin entry and reports it as `present but blocked`. Fix the preceding blocked-plugin diagnostic, such as path ownership or world-writable permissions, instead of removing the `plugins.entries.<id>` or `plugins.allow` config.

For module-shape failures such as missing `register`/`activate` exports, rerun with `OPENCLAW_PLUGIN_LOAD_DEBUG=1` to include a compact export-shape summary in the diagnostic output.

## Registry

```bash
openclaw plugins registry
openclaw plugins registry --refresh
openclaw plugins registry --json
```

The local plugin registry is OpenClaw's persisted cold read model for installed plugin identity, enablement, source metadata, and contribution ownership. Normal startup, provider owner lookup, channel setup classification, and plugin inventory can read it without importing plugin runtime modules.

Use `plugins registry` to inspect whether the persisted registry is present, current, or stale. Use `--refresh` to rebuild it from the persisted plugin index, config policy, and manifest/package metadata. This is a repair path, not a runtime activation path.

When persisted and derived plugin records differ, the command lists each differing plugin with both sources. JSON output returns the same rows in `differences`. Policy staleness reports `policy-changed` in `refreshReasons` and leaves `differences` empty because policy validation runs before record comparison; a policy refresh can still update enabled fields. A refresh rereads and verifies its persisted replacement before it reports success. If plugin package files keep changing during verification, stop those updates and run `openclaw plugins registry --refresh` again.

`openclaw doctor --fix` also repairs registry-adjacent managed npm drift. If an orphaned or recovered `@openclaw/*` package under a managed plugin npm project or the legacy flat managed npm root shadows a bundled plugin, doctor removes that stale package and rebuilds the registry so startup validates against the bundled manifest. When an authoritative install record selects one managed generation but older flat or generation directories remain, doctor retires those stale trees for pruning after the gateway restarts. Doctor also relinks the host `openclaw` package into managed npm plugins that declare `peerDependencies.openclaw`, so package-local runtime imports such as `openclaw/plugin-sdk/*` resolve after updates or npm repairs.
