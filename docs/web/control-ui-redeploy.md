---
summary: "Rebuild and redeploy a customized Control UI from an OpenClaw source checkout"
read_when:
  - You changed ui/index.html, login-gate.ts, styles, or locale strings
  - Your npm-installed OpenClaw package was upgraded and overwrote dist/control-ui
  - You need to resync a local Control UI customization into the live package
title: "Control UI redeploy"
---

Use this runbook when you maintain a local Control UI customization in an OpenClaw source checkout and need to push the built UI back into the installed package.

## What this updates

Source-of-truth files typically live here:

- `ui/index.html`
- `ui/src/ui/views/login-gate.ts`
- `ui/src/styles/components.css`
- `ui/src/i18n/locales/*.ts`

Build output lands in:

- `dist/control-ui/`

A global npm install serves the built UI from:

- `$(npm root -g)/openclaw/dist/control-ui/`

On this machine today that resolves to a path like:

- `/home/gonzo/.hermes/node/lib/node_modules/openclaw/dist/control-ui/`

## One-command redeploy

From the repo root:

```bash
scripts/redeploy-control-ui.sh
```

The script will:

1. build the Control UI from source
2. sync `dist/control-ui/` into the installed OpenClaw package
3. restart `openclaw-gateway.service`
4. verify the deployed `index.html` matches the built output

## Overrides

You can override the install target or service name if your environment differs:

```bash
OPENCLAW_INSTALLED_DIR=/path/to/openclaw/dist/control-ui \
OPENCLAW_GATEWAY_SERVICE=my-openclaw-gateway.service \
  scripts/redeploy-control-ui.sh
```

## Verification

After redeploy, verify:

- the script prints `same_index True`
- the gateway service is active
- the browser-served Control UI reflects your expected text/layout changes

Quick manual check:

```bash
python - <<'PY'
from pathlib import Path
import subprocess
npm_root = subprocess.check_output(['npm', 'root', '-g'], text=True).strip()
built = Path('dist/control-ui/index.html')
installed = Path(npm_root) / 'openclaw' / 'dist' / 'control-ui' / 'index.html'
print({'built_exists': built.exists(), 'installed_exists': installed.exists(), 'same_index': built.exists() and installed.exists() and built.read_text() == installed.read_text()})
PY
```

## When to use this instead of `gateway.controlUi.root`

Use this script when you specifically want the npm-installed OpenClaw package to serve your customized UI directly.

If you want to keep custom UI assets outside the installed package, consider `gateway.controlUi.root` instead; see [Control UI](/web/control-ui).
