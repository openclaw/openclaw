# Custom Control UI Runtime Deploy

This workflow guarantees your custom UI is applied to the exact bundle served by OpenClaw gateway runtime.

## Why UI changes sometimes do not appear

OpenClaw gateway serves Control UI from global package path:

`<npm root -g>/openclaw/dist/control-ui`

If you only build inside the repo (`dist/control-ui`) but do not copy to that runtime path, the browser still shows old UI.

## One-command deploy

From repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-custom-control-ui.ps1 -RestartGateway
```

What it does:

1. Builds `dist/control-ui`.
2. Backs up current runtime UI to `%USERPROFILE%\.openclaw\openclaw-custom-backup\release-snapshots\control-ui-<timestamp>`.
3. Mirrors custom bundle into runtime `dist/control-ui`.
4. Optionally restarts gateway.

## Fast deploy without rebuilding

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-custom-control-ui.ps1 -SkipBuild -RestartGateway
```

## Post-update checklist

After every `npm i -g openclaw@latest`:

1. Run deploy script again.
2. Hard refresh browser (`Ctrl+Shift+R`).
3. Verify runtime `Version` in UI and confirm custom elements are visible.
