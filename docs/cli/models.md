---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI reference for `openclaw models` (status/list/set/scan, aliases, fallbacks, auth)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to change default models or view provider auth status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to scan available models/providers and debug auth profiles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "models"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# `openclaw models`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Model discovery, scanning, and configuration (default model, fallbacks, auth profiles).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers + models: [Models](/providers/models)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider auth setup: [Getting started](/start/getting-started)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models set <model-or-alias>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models scan（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw models status` shows the resolved default/fallbacks plus an auth overview.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When provider usage snapshots are available, the OAuth/token status section includes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
provider usage headers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add `--probe` to run live auth probes against each configured provider profile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Probes are real requests (may consume tokens and trigger rate limits).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `--agent <id>` to inspect a configured agent’s model/auth state. When omitted,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the command uses `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` if set, otherwise the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
configured default agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `models set <model-or-alias>` accepts `provider/model` or an alias.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model refs are parsed by splitting on the **first** `/`. If the model ID includes `/` (OpenRouter-style), include the provider prefix (example: `openrouter/moonshotai/kimi-k2`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you omit the provider, OpenClaw treats the input as an alias or a model for the **default provider** (only works when there is no `/` in the model ID).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `models status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--plain`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--check` (exit 1=expired/missing, 2=expiring)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--probe` (live probe of configured auth profiles)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--probe-provider <name>` (probe one provider)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--probe-profile <id>` (repeat or comma-separated profile ids)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--probe-timeout <ms>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--probe-concurrency <n>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--probe-max-tokens <n>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--agent <id>` (configured agent id; overrides `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Aliases + fallbacks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models aliases list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models fallbacks list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auth profiles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth add（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth login --provider <id>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth setup-token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth paste-token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`models auth login` runs a provider plugin’s auth flow (OAuth/API key). Use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw plugins list` to see which providers are installed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `setup-token` prompts for a setup-token value (generate it with `claude setup-token` on any machine).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `paste-token` accepts a token string generated elsewhere or from automation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
