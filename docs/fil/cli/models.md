---
summary: "Sanggunian ng CLI para sa `openclaw models` (status/list/set/scan, mga alias, mga fallback, auth)"
read_when:
  - Gusto mong baguhin ang mga default na model o tingnan ang status ng auth ng provider
  - Gusto mong i-scan ang mga available na model/provider at i-debug ang mga auth profile
title: "mga model"
x-i18n:
  source_path: cli/models.md
  source_hash: 923b6ffc7de382ba
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:20Z
---

# `openclaw models`

Discovery ng model, pag-scan, at konpigurasyon (default na model, mga fallback, mga auth profile).

Kaugnay:

- Mga provider + model: [Models](/providers/models)
- Setup ng auth ng provider: [Pagsisimula](/start/getting-started)

## Mga karaniwang command

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` ipinapakita ang resolved na default/mga fallback kasama ang pangkalahatang-ideya ng auth.
Kapag may available na mga snapshot ng paggamit ng provider, kasama sa seksyon ng status ng OAuth/token ang
mga header ng paggamit ng provider.
Idagdag ang `--probe` para magpatakbo ng live na mga auth probe laban sa bawat naka-configure na profile ng provider.
Ang mga probe ay totoong request (maaaring kumonsumo ng mga token at mag-trigger ng mga rate limit).
Gamitin ang `--agent <id>` para siyasatin ang estado ng model/auth ng isang naka-configure na agent. Kapag hindi isinama,
gagamitin ng command ang `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` kung naka-set, kung hindi ay ang
naka-configure na default agent.

Mga tala:

- Tumatanggap ang `models set <model-or-alias>` ng `provider/model` o isang alias.
- Ang mga model ref ay pino-parse sa pamamagitan ng paghahati sa **unang** `/`. Kung kasama sa model ID ang `/` (OpenRouter-style), isama ang prefix ng provider (halimbawa: `openrouter/moonshotai/kimi-k2`).
- Kung aalisin mo ang provider, ituturing ng OpenClaw ang input bilang isang alias o isang model para sa **default provider** (gumagana lamang kapag walang `/` sa model ID).

### `models status`

Mga opsyon:

- `--json`
- `--plain`
- `--check` (exit 1=expired/missing, 2=expiring)
- `--probe` (live probe ng mga naka-configure na auth profile)
- `--probe-provider <name>` (i-probe ang isang provider)
- `--probe-profile <id>` (ulitin o comma-separated na mga profile id)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (naka-configure na agent id; ina-override ang `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## Mga alias + mga fallback

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Mga auth profile

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

Pinapatakbo ng `models auth login` ang auth flow ng provider plugin (OAuth/API key). Gamitin ang
`openclaw plugins list` para makita kung aling mga provider ang naka-install.

Mga tala:

- Hinihingi ng `setup-token` ang isang setup-token na value (i-generate ito gamit ang `claude setup-token` sa anumang machine).
- Tumatanggap ang `paste-token` ng token string na na-generate sa ibang lugar o mula sa automation.
