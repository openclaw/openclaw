---
summary: "`plugins list` output and options, discovery diagnostics, and the persisted plugin index"
title: "List installed plugins"
read_when:
  - You want to check whether a plugin is installed, enabled, and discoverable
  - You are debugging a `plugins.allow` warning or the persisted plugin index
---

This page covers `openclaw plugins list`, its options and discovery
diagnostics, and the machine-managed plugin index that backs it.

## List

```bash
openclaw plugins list
openclaw plugins list --enabled
openclaw plugins list --verbose
openclaw plugins list --json
```

<ParamField path="--enabled" type="boolean">
  Show only enabled plugins.
</ParamField>
<ParamField path="--verbose" type="boolean">
  Switch from the table view to per-plugin detail lines with format/source/origin/version/activation metadata.
</ParamField>
<ParamField path="--json" type="boolean">
  Machine-readable inventory plus registry diagnostics and package dependency install state.
</ParamField>

<Note>
`plugins list` reads the persisted local plugin registry first, with a manifest-only derived fallback when the registry is missing or invalid. It is useful for checking whether a plugin is installed, enabled, and visible to cold startup planning, but it is not a live runtime probe of an already-running Gateway process. After changing plugin code or `plugins.load.paths`, restart the Gateway that serves the channel before expecting new `register(api)` code or hooks to run. With the default hybrid reload mode, enablement and hook policy changes hot-reload the existing plugin runtime unless the plugin declares a restart-triggering prefix. For remote/container deployments, verify you are restarting the actual `openclaw gateway run` child, not only a wrapper process.

`plugins list --json` includes each plugin's `dependencyStatus` from `package.json`
`dependencies` and `optionalDependencies`. OpenClaw checks whether those package
names are present along the plugin's normal Node `node_modules` lookup path; it
does not import plugin runtime code, run a package manager, or repair missing
dependencies.
</Note>

If startup logs `plugins.allow is empty; discovered non-bundled plugins may auto-load: ...`,
run `openclaw plugins list --enabled --verbose` or
`openclaw plugins inspect <id>` with a listed plugin id to confirm the plugin
ids and copy trusted ids into `plugins.allow` in `openclaw.json`. When the
warning can list every discovered plugin, it prints a ready-to-paste
`plugins.allow` snippet that already includes those ids. If a plugin loads
without install/load-path provenance, inspect that plugin id, then either pin
the trusted id in `plugins.allow` or reinstall the plugin from a trusted source
so OpenClaw records install provenance.

For bundled plugin work inside a packaged Docker image, bind-mount the plugin
source directory over the matching packaged source path, such as
`/app/extensions/synology-chat`. OpenClaw discovers that mounted source overlay
before `/app/dist/extensions/synology-chat`; a plain copied source directory
remains inert, so normal packaged installs still use compiled dist.

For runtime hook debugging:

- `openclaw plugins inspect <id> --runtime --json` shows registered hooks and diagnostics from a module-loaded inspection pass. Runtime inspection uses an uncached, non-activating registry and releases its inspection claim before printing the result. It awaits disposal due for that release, and a failure prevents a successful result. If an SDK host still borrows provider callbacks from the inspection, that host retains their backing resources and reports any later disposal failure during teardown; see [retained SDK contracts](/plugins/sdk-migration/compatibility-policy#retained-helper-contracts). This does not stop the running Gateway or invoke context-engine factories. Runtime inspection never installs dependencies; use `openclaw doctor --fix` to clean legacy dependency state or recover missing downloadable plugins that are referenced by config.
- `openclaw gateway status --deep --require-rpc` confirms the reachable Gateway URL/profile, service/process hints, config path, and RPC health.
- If a hook-only plugin is absent from runtime inspection, confirm its [hook startup intent](/tools/plugin#plugin-hooks): either manifest `activation.onCapabilities: ["hook"]` with explicit plugin enablement, or a startup-signaling `plugins.entries.<id>.hooks` policy such as `allowConversationAccess: true`. Global disable, deny, and restrictive allowlists still win.
- Non-bundled conversation hooks (`before_model_resolve`, `agent_turn_prepare`, `before_prompt_build`, `before_agent_reply`, `llm_input`, `llm_output`, `before_agent_run`, `before_agent_finalize`, `agent_end`) require `plugins.entries.<id>.hooks.allowConversationAccess=true`.

### Plugin index

Plugin install metadata is machine-managed state, not user config. Installs and updates write it to the shared SQLite state database under the active OpenClaw state directory. The `config_machine_state` value keyed by `plugins.installedIndex` stores durable `installRecords` metadata, including records for broken or missing plugin manifests, plus a manifest-derived cold registry cache used by `openclaw plugins update`, uninstall, diagnostics, and the cold plugin registry.

An unreadable index is not invalid data. Permission, lock, and other read errors stop fallback, migration, and refresh with the original error. Restore database access, then rerun `openclaw plugins registry` to inspect the state before attempting repair. Do not delete the `plugins.installedIndex` row unless inspection succeeds and confirms invalid install records; a failed read alone does not justify deletion.

`plugins.installs` is a retired authored-config surface. Runtime and update commands read only the SQLite machine-state plugin index. Run `openclaw doctor --fix` to import legacy config records into the index and remove the retired key before normal runtime use.
