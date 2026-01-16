---
summary: "CLI reference for `clawdbot models` (status/list/set/scan, aliases, fallbacks, auth)"
read_when:
  - You want to change default models or view provider auth status
  - You want to scan available models/providers and debug auth profiles
---

# `clawdbot models`

Model discovery, scanning, and configuration (default model, fallbacks, auth profiles).

Related:
- Providers + models: [Models](/providers/models)
- Provider auth setup: [Getting started](/start/getting-started)

## Common commands

```bash
clawdbot models status
clawdbot models list
clawdbot models set <model-or-alias>
clawdbot models scan
```

`clawdbot models status` shows the resolved default/fallbacks plus an auth overview.
When provider usage snapshots are available, the OAuth/token status section includes
provider usage headers.

## Aliases + fallbacks

```bash
clawdbot models aliases list
clawdbot models fallbacks list
```

## Auth profiles

```bash
clawdbot models auth add
clawdbot models auth login --provider <id>
clawdbot models auth setup-token
clawdbot models auth paste-token
```
`models auth login` runs a provider plugin’s auth flow (OAuth/API key). Use
`clawdbot plugins list` to see which providers are installed.

Notes:
- `setup-token` runs `claude setup-token` on the current machine (requires the Claude Code CLI).
- `paste-token` accepts a token string generated elsewhere.
