# VioDashboard run modes

## Summary

VioDashboard now supports two launch modes:

- `source` — run live directly from the current checkout's `apps/viodashboard` directory
- `runtime` — run from `~/Library/Application Support/VioDashboardRuntime`

The default mode is `source`.

## Why this exists

The previous live setup always ran from a copied runtime directory. That caused UI edits to require a runtime sync before a restart would pick up new CSS/JS/HTML. Source mode removes that extra deployment layer during development.

## Files involved

- `launchd/com.vio.dashboard.plist`
- `launchd/run-dashboard.sh`
- `launchd/install.sh`
- `launchd/set-mode.sh`
- `launchd/sync-runtime.sh`
- `launchd/.run-mode`

## Install / reload

Install in source mode (default):

```bash
bash launchd/install.sh
```

Install explicitly in source mode:

```bash
bash launchd/install.sh source
```

Install explicitly in runtime mode:

```bash
bash launchd/install.sh runtime
```

## Switch modes later

Switch to source mode:

```bash
bash launchd/set-mode.sh source
```

Switch to runtime mode:

```bash
bash launchd/set-mode.sh runtime
```

When switching to runtime mode, `sync-runtime.sh` is run before the service is restarted.

## One-command reload

Preferred source-mode reload:

```bash
bash launchd/reload.sh
```

Explicit source-mode reload:

```bash
bash launchd/reload.sh source
```

Runtime-mode reload with runtime sync:

```bash
bash launchd/reload.sh runtime
```

Reload and open the page:

```bash
bash launchd/reload.sh source --open
```

## Current recommended usage

For UI work and active development, use **source mode**.

For fallback / recovery / comparison against the old deployment model, use **runtime mode**.

## Verification

Check current mode, launchd state, expected live root, and quick `/` + `/styles.css` health:

```bash
bash launchd/status.sh
```

Useful live verification steps after UI edits:

1. reload service in source mode
2. run `bash launchd/status.sh`
3. confirm `/` and `/styles.css` both return `200`
4. refresh the page and visually verify the layout

## Notes

- `sync-runtime.sh` is no longer the main path for source-mode development.
- `sync-runtime.sh` remains part of runtime-mode fallback.
- `launchd/install.sh` now writes the LaunchAgent plist dynamically for the current checkout path instead of committing a machine-specific absolute path.
- The launch agent calls `launchd/run-dashboard.sh`, which chooses the actual run directory based on `launchd/.run-mode` (or `VIO_DASHBOARD_RUN_MODE` if set manually).
