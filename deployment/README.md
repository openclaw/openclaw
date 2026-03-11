# Portable OpenClaw (deployment-local mode)

This deployment is now self-contained around `./deployment`:

- local binary entry in `deployment/bin/openclaw`
- local Windows entry in `deployment/bin/openclaw.cmd`
- bundled Node binary in `deployment/bin/node-<os>-<arch>`
- config root is `deployment/config`
- default data root is `deployment/data`
- compiled runtime in `deployment/bin/runtime` (`openclaw.mjs + dist + node_modules + docs/reference/templates`)

Preloaded config baseline:

- `gateway.mode=local`
- `gateway.port=18789`
- `gateway.bind=loopback`
- `gateway.auth.mode=token`
- `agents.defaults.model.primary=openai-codex/gpt-5.4`

## Files

- `deployment/bin/openclaw`
- `deployment/bin/openclaw.cmd`
- `deployment/bin/node-<os>-<arch>`
- `deployment/bin/runtime/openclaw.mjs`
- `deployment/bin/runtime/dist/*`
- `deployment/bin/runtime/node_modules/*`
- `deployment/bin/runtime/docs/reference/templates/*`
- `deployment/build-local-runtime.sh`
- `deployment/build-local-runtime.ps1`
- `deployment/migrate-local-mac.sh`
- `deployment/verify-env.sh`
- `deployment/config/openclaw-mac.json`
- `deployment/config/openclaw-wsl.json`
- `deployment/config/openclaw-win.json`
- `deployment/usb-openclaw-mac.sh`
- `deployment/usb-openclaw-wsl.sh`
- `deployment/usb-openclaw-win-native.ps1`
- `deployment/usb-openclaw-win.ps1`

## Config vs Data

- `deployment/config/openclaw-*.json` uses the same schema as the normal OpenClaw `openclaw.json`.
- Config files (editable):
  - macOS: `deployment/config/openclaw-mac.json`
  - WSL: `deployment/config/openclaw-wsl.json`
  - Windows native: `deployment/config/openclaw-win.json`
- State/data files (runtime output):
  - `deployment/data/state-*`
  - `deployment/data/workspace`
  - `deployment/data/codex-home`

## Migrate Existing Local Environment (macOS)

If you want to replicate your current machine's OpenClaw environment (config + credentials/state) into `deployment`:

```bash
chmod +x deployment/migrate-local-mac.sh
./deployment/migrate-local-mac.sh
```

This copies:

- `~/.openclaw/openclaw.json` -> `deployment/config/openclaw-mac.json`
- `~/.openclaw/*` -> `deployment/data/state-mac/*`
- source workspace `.openclaw/*`, `skills/*`, `.agents/skills/*`, `memory/*`, and common root files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, `MEMORY.md`) -> `deployment/data/workspace/...` (if source workspace is set)
- `~/.codex/auth.json` -> `deployment/data/codex-home/auth.json` (if present)
- `~/.codex/skills/*` -> `deployment/data/codex-home/skills/*` (if present)
- macOS `Codex Auth` keychain entry -> target `CODEX_HOME` keychain account (best effort)
- `agents.defaults.workspace` -> `deployment/data/workspace`

Then run:

```bash
./deployment/usb-openclaw-mac.sh run ./deployment/data dashboard
```

Verify migration completeness:

```bash
./deployment/verify-env.sh mac ./deployment/data ./deployment/config
```

## Build local runtime

```bash
chmod +x deployment/build-local-runtime.sh
./deployment/build-local-runtime.sh
```

This step compiles current source code, builds Control UI assets, and copies runtime files into `deployment/bin/runtime`.
It also copies `docs/reference/templates` into `deployment/bin/runtime/docs/reference/templates`.
It also bundles runtime dependencies into `deployment/bin/runtime/node_modules`.
It also copies current machine's Node binary into `deployment/bin/node-<os>-<arch>`.

## Build local runtime (Windows PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File .\deployment\build-local-runtime.ps1
```

This does the same as the shell script and also bundles current Windows Node into:

- `deployment\bin\node-win-x86_64.exe` or
- `deployment\bin\node-win-arm64.exe`

## macOS

```bash
chmod +x deployment/bin/openclaw deployment/usb-openclaw-mac.sh
./deployment/usb-openclaw-mac.sh run
```

Open dashboard with tokenized URL (recommended for `gateway.auth.mode=token`):

```bash
./deployment/usb-openclaw-mac.sh dashboard
```

Optional custom root:

```bash
./deployment/usb-openclaw-mac.sh run ./deployment/data
```

Optional custom config root:

```bash
OPENCLAW_CONFIG_ROOT=./deployment/config ./deployment/usb-openclaw-mac.sh run ./deployment/data
```

Run gateway and auto-open dashboard in one command:

```bash
./deployment/usb-openclaw-mac.sh run ./deployment/data dashboard
```

## Windows Native (No WSL)

```powershell
powershell -ExecutionPolicy Bypass -File .\deployment\usb-openclaw-win.ps1 -Action run
```

Optional custom root:

```powershell
powershell -ExecutionPolicy Bypass -File .\deployment\usb-openclaw-win.ps1 -Action run -UsbRoot "D:\portable-openclaw-data"
```

Optional custom config root:

```powershell
powershell -ExecutionPolicy Bypass -File .\deployment\usb-openclaw-win.ps1 -Action run -ConfigRoot "D:\portable-openclaw-config"
```

Open dashboard with tokenized URL:

```powershell
powershell -ExecutionPolicy Bypass -File .\deployment\usb-openclaw-win.ps1 -Action dashboard
```

Run gateway and auto-open dashboard in one command:

```powershell
powershell -ExecutionPolicy Bypass -File .\deployment\usb-openclaw-win.ps1 -Action run -Dashboard
```

The wrapper defaults to native mode (`-Mode native`). You can also call native script directly:

```powershell
powershell -ExecutionPolicy Bypass -File .\deployment\usb-openclaw-win-native.ps1 -Action run
```

Native direct dashboard:

```powershell
powershell -ExecutionPolicy Bypass -File .\deployment\usb-openclaw-win-native.ps1 -Action dashboard
```

## Windows (PowerShell + WSL)

```powershell
powershell -ExecutionPolicy Bypass -File .\deployment\usb-openclaw-win.ps1 -Mode wsl -Action run
```

## WSL direct

```bash
chmod +x deployment/bin/openclaw deployment/usb-openclaw-wsl.sh
./deployment/usb-openclaw-wsl.sh run
```

Optional custom config root:

```bash
OPENCLAW_CONFIG_ROOT=./deployment/config ./deployment/usb-openclaw-wsl.sh run ./deployment/data
```

## Customize LLM And Channels

Recommended workflow:

1. Start once with `init` or `run` to generate token and baseline.
2. Edit the platform config JSON in `deployment/config/`.
3. Restart gateway with the same script.

LLM model key:

- `agents.defaults.model.primary`

Example (macOS):

```bash
OPENCLAW_STATE_DIR=./deployment/data/state-mac \
OPENCLAW_CONFIG_PATH=./deployment/config/openclaw-mac.json \
CODEX_HOME=./deployment/data/codex-home \
./deployment/bin/openclaw config set agents.defaults.model.primary openai-codex/gpt-5.4
```

Channel configuration:

- channel config is in the same JSON file (`deployment/config/openclaw-*.json`)
- to configure channels safely, run the interactive wizard with the same config path:

```bash
OPENCLAW_STATE_DIR=./deployment/data/state-mac \
OPENCLAW_CONFIG_PATH=./deployment/config/openclaw-mac.json \
CODEX_HOME=./deployment/data/codex-home \
./deployment/bin/openclaw configure
```

## Notes

- Scripts default to `deployment/config` for config and `deployment/data` for state/workspace.
- Scripts set `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and `CODEX_HOME` automatically.
- Scripts run `openclaw setup --workspace <resolved-workspace>` on startup to ensure bootstrap files exist (`AGENTS.md`, `SOUL.md`, `USER.md`, etc.) without overwriting existing files.
- If both `MEMORY.md` and `memory.md` are absent, scripts create a starter `MEMORY.md`.
- If `gateway.auth.token` is missing, scripts auto-generate one.
- Scripts sync OpenAI Codex OAuth from `CODEX_HOME/auth.json` into `state-*/agents/main/agent/auth-profiles.json` before start.
- macOS script auto-detects expired/shared OpenAI Codex refresh tokens and runs interactive re-login before gateway start (set `OPENCLAW_AUTO_CODEX_RELOGIN=0` to disable).
- Scripts only fill missing defaults; they do not overwrite existing custom values in imported config.
- For full 1:1 migration, copy both config and state. Config alone may miss credentials stored in state files.
- Env-only secrets (for example keys exported only in shell env) are not persisted to config/state; set them again on the target machine.
- Runtime scripts only read binaries/runtime under `deployment/bin` and do not reference files outside `deployment`.

## Troubleshooting

### gateway token mismatch in dashboard

If you see `unauthorized: gateway token mismatch`:

1. Use the exact `Dashboard URL: ...#token=...` printed by the script.
2. If browser auto-open is unavailable, copy-paste that URL manually.
3. If it still fails, clear token in Control UI settings (or open an incognito window) and re-open the printed tokenized URL.

### Control UI assets not found

If you see `Control UI assets not found...`:

1. Rebuild deployment runtime on source machine:
   - `./deployment/build-local-runtime.sh`
2. Re-copy updated `deployment/bin/runtime` to target machine.
3. Start again:
   - `./deployment/usb-openclaw-mac.sh run ./deployment/data dashboard`

### openai-codex refresh_token_reused

If you see `OAuth token refresh failed ... refresh_token_reused`:

1. Re-run migration to re-sync state + Codex auth:
   - `./deployment/migrate-local-mac.sh`
2. Start again:
   - `./deployment/usb-openclaw-mac.sh run ./deployment/data dashboard`
3. If still failing, re-login OpenAI Codex for this deployment env:
   - `OPENCLAW_STATE_DIR=./deployment/data/state-mac OPENCLAW_CONFIG_PATH=./deployment/config/openclaw-mac.json CODEX_HOME=./deployment/data/codex-home ./deployment/bin/openclaw models auth login openai-codex`
4. If Codex app and deployment are both active, avoid sharing the same refresh-token chain; keep only one active session or re-login both sides.

Optional: if you want to sync from a non-default source Codex home, set:

- `OPENCLAW_SOURCE_CODEX_HOME=/path/to/source/.codex`
- `OPENCLAW_CODEX_SOURCE_SYNC_MODE=if-missing|always|off` (default: `if-missing`)

### Provided authentication token is expired

If you see `Provided authentication token is expired. Please try signing in again.`:

1. Re-run migration + startup (latest scripts now derive token expiry from JWT `exp` and force refresh when needed):
   - `./deployment/migrate-local-mac.sh`
   - `./deployment/usb-openclaw-mac.sh run ./deployment/data dashboard`
2. If still failing, re-login OpenAI Codex in deployment env:
   - `OPENCLAW_STATE_DIR=./deployment/data/state-mac OPENCLAW_CONFIG_PATH=./deployment/config/openclaw-mac.json CODEX_HOME=./deployment/data/codex-home ./deployment/bin/openclaw models auth login openai-codex`
