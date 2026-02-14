# QVerisBot Installation Guide

Use this page to choose the fastest installation path for QVerisBot.

## Installation methods

### One-liner (macOS / Linux)

```bash
curl -fsSL https://qveris.ai/qverisbot/install.sh | bash
```

### npm (global package)

```bash
npm i -g @qverisai/qverisbot
qverisbot onboard
```

The compatibility alias still works:

```bash
openclaw onboard
```

### Windows PowerShell

```powershell
irm https://qveris.ai/qverisbot/install.ps1 | iex
```

### Hackable install (source mode)

```bash
curl -fsSL https://qveris.ai/qverisbot/install.sh | bash -s -- --install-method git
```

Or follow the full source guide: [QVerisBot from source](/qverisbot-from-source).

## System requirements

| Component | Minimum | Recommended   |
| :-------- | :------ | :------------ |
| Node.js   | 22.12.0 | 22.x LTS      |
| npm       | 10.x    | Latest stable |
| Python    | 3.12+   | 3.12+         |
| Git       | 2.x     | Latest stable |

## After installation

Run onboarding:

```bash
qverisbot onboard
```

Then verify:

```bash
qverisbot --version
qverisbot channels status
```

## Troubleshooting

- If `qverisbot` is not found, reopen your shell so global npm bin paths are reloaded.
- If Node.js is below 22, upgrade Node first, then rerun the installer.
- If your network requires a proxy, set `HTTP_PROXY` and `HTTPS_PROXY` before install.
- If install succeeds but onboarding fails, run `qverisbot doctor`.
