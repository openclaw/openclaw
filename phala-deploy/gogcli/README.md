# gogcli in OpenClaw

Google API CLI ([gogcli](https://github.com/steipete/gogcli)) for Gmail, Calendar, Drive, Sheets, Docs, and more — built into the OpenClaw Docker image.

Uses a [fork](https://github.com/Leechael/gogcli/tree/feat/env-token-injection) that adds environment variable credential injection, enabling headless/containerized use without interactive OAuth or OS keyring.

## How it works

The Dockerfile builds gogcli as a static binary (`gog-bin`) in a multi-stage Go builder, then copies it into the runtime image alongside a thin bash wrapper installed as `gog`.

```
/usr/local/bin/gog       <- wrapper script (sources credentials, execs gog-bin)
/usr/local/bin/gog-bin   <- static binary (CGO_ENABLED=0, stripped)
```

The wrapper (`gog-wrapper.sh`) sources `~/.config/clawdi/gmail.env` before every invocation. Since the entrypoint already symlinks `~/.config` to `/data/.config`, credentials persist across container restarts automatically.

If the env file is absent, gog falls back to its normal credential-file/keyring auth.

## Configuration

Create `~/.config/clawdi/gmail.env` (or `/data/.config/clawdi/gmail.env`) with:

```env
GOG_CLIENT_ID=your-client-id
GOG_CLIENT_SECRET=your-client-secret
GOG_REFRESH_TOKEN=your-refresh-token
GOG_ACCOUNT=user@gmail.com
```

No `export` prefix needed — the wrapper uses `set -a` to auto-export all variables.

## Usage

```bash
gog gmail list              # list recent emails
gog calendar list           # list calendar events
gog drive list              # list drive files
gog --help                  # full command reference
```

## Build details

| Detail | Value |
|--------|-------|
| Source | `github.com/Leechael/gogcli` branch `feat/env-token-injection` |
| Build | `CGO_ENABLED=0`, stripped (`-s -w`) |
| Binary size | ~21MB |
| Linked | Static (no libc dependency) |
