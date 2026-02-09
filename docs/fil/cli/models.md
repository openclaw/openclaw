---
summary: "Sanggunian ng CLI para sa `openclaw models` (status/list/set/scan, mga alias, mga fallback, auth)"
read_when:
  - Gusto mong baguhin ang mga default na model o tingnan ang status ng auth ng provider
  - Gusto mong i-scan ang mga available na model/provider at i-debug ang mga auth profile
title: "mga model"
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

Ipinapakita ng `openclaw models status` ang resolved default/fallbacks kasama ang auth overview.
Kapag available ang mga snapshot ng paggamit ng provider, kasama sa seksyon ng OAuth/token status ang mga provider usage header.
Idagdag ang `--probe` upang magpatakbo ng mga live auth probe laban sa bawat naka-configure na provider profile.
Ang mga probe ay mga totoong request (maaaring kumonsumo ng mga token at mag-trigger ng rate limits).
Gamitin ang `--agent <id>` upang siyasatin ang model/auth state ng isang naka-configure na agent. Kapag hindi isinama,
gagamitin ng command ang `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` kung naka-set, kung hindi ay ang naka-configure na default agent.

Mga tala:

- Tumatanggap ang `models set <model-or-alias>` ng `provider/model` o isang alias.
- Ang mga model ref ay pina-parse sa pamamagitan ng paghahati sa **unang** `/`. Kung ang model ID ay may kasamang `/` (OpenRouter-style), isama ang provider prefix (halimbawa: `openrouter/moonshotai/kimi-k2`).
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

Pinapatakbo ng `models auth login` ang auth flow (OAuth/API key) ng provider plugin. Gamitin ang
`openclaw plugins list` upang makita kung aling mga provider ang naka-install.

Mga tala:

- Hinihingi ng `setup-token` ang isang setup-token na value (i-generate ito gamit ang `claude setup-token` sa anumang machine).
- Tumatanggap ang `paste-token` ng token string na na-generate sa ibang lugar o mula sa automation.
