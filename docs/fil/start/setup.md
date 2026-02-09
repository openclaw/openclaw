---
summary: "Advanced na setup at mga workflow para sa development ng OpenClaw"
read_when:
  - Nagse-setup ng bagong machine
  - Gusto mo ng “latest + greatest” nang hindi nasisira ang personal mong setup
title: "Setup"
---

# Setup

<Note>
Kung unang beses kang magse‑setup, magsimula sa [Getting Started](/start/getting-started).
Para sa mga detalye ng wizard, tingnan ang [Onboarding Wizard](/start/wizard).
</Note>

Huling na-update: 2026-01-01

## TL;DR

- **Ang pag-tailor ay nasa labas ng repo:** `~/.openclaw/workspace` (workspace) + `~/.openclaw/openclaw.json` (config).
- **Stable na workflow:** i-install ang macOS app; hayaan itong patakbuhin ang bundled Gateway.
- **Bleeding edge na workflow:** patakbuhin mo mismo ang Gateway gamit ang `pnpm gateway:watch`, tapos hayaan ang macOS app na kumabit sa Local mode.

## Prereqs (mula sa source)

- Node `>=22`
- `pnpm`
- Docker (opsyonal; para lang sa containerized setup/e2e — tingnan ang [Docker](/install/docker))

## Tailoring strategy (para hindi masakit ang updates)

Kung gusto mo ng “100% tailored sa akin” _at_ madadaling update, ilagay ang customization mo sa:

- **Config:** `~/.openclaw/openclaw.json` (JSON/JSON5-ish)
- **Workspace:** `~/.openclaw/workspace` (Skills, prompts, memories; gawing private git repo)

Mag-bootstrap nang isang beses:

```bash
openclaw setup
```

Mula sa loob ng repo na ito, gamitin ang local CLI entry:

```bash
openclaw setup
```

Kung wala ka pang global install, patakbuhin ito via `pnpm openclaw setup`.

## Patakbuhin ang Gateway mula sa repo na ito

Pagkatapos ng `pnpm build`, maaari mong patakbuhin ang packaged CLI nang direkta:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Stable na workflow (macOS app muna)

1. I-install at i-launch ang **OpenClaw.app** (menu bar).
2. Kumpletuhin ang onboarding/permissions checklist (TCC prompts).
3. Tiyaking **Local** ang Gateway at tumatakbo (ang app ang namamahala).
4. I-link ang mga surface (halimbawa: WhatsApp):

```bash
openclaw channels login
```

5. Sanity check:

```bash
openclaw health
```

Kung hindi available ang onboarding sa build mo:

- Patakbuhin ang `openclaw setup`, pagkatapos `openclaw channels login`, saka simulan nang manu-mano ang Gateway (`openclaw gateway`).

## Bleeding edge na workflow (Gateway sa terminal)

Layunin: magtrabaho sa TypeScript Gateway, makakuha ng hot reload, at panatilihing nakakabit ang macOS app UI.

### 0. (Opsyonal) Patakbuhin din ang macOS app mula sa source

Kung gusto mo ring nasa bleeding edge ang macOS app:

```bash
./scripts/restart-mac.sh
```

### 1. Simulan ang dev Gateway

```bash
pnpm install
pnpm gateway:watch
```

Pinapatakbo ng `gateway:watch` ang gateway sa watch mode at nagre-reload sa mga pagbabago sa TypeScript.

### 2. Ituro ang macOS app sa tumatakbong Gateway mo

Sa **OpenClaw.app**:

- Connection Mode: **Local**
  Kakabit ang app sa tumatakbong gateway sa naka-configure na port.

### 3. I-verify

- Dapat magpakita ang in-app Gateway status ng **“Using existing gateway …”**
- O via CLI:

```bash
openclaw health
```

### Mga karaniwang footgun

- **Maling port:** Ang Gateway WS ay default na `ws://127.0.0.1:18789`; panatilihing pareho ang port ng app at CLI.
- **Saan naninirahan ang state:**
  - Credentials: `~/.openclaw/credentials/`
  - Sessions: `~/.openclaw/agents/<agentId>/sessions/`
  - Logs: `/tmp/openclaw/`

## Mapa ng credential storage

Gamitin ito kapag nagde-debug ng auth o nagpapasya kung ano ang iba-back up:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**: config/env o `channels.telegram.tokenFile`
- **Discord bot token**: config/env (hindi pa suportado ang token file)
- **Slack tokens**: config/env (`channels.slack.*`)
- **Pairing allowlists**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **Model auth profiles**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **Legacy OAuth import**: `~/.openclaw/credentials/oauth.json`
  Mas detalyado: [Security](/gateway/security#credential-storage-map).

## Pag-update (nang hindi sinisira ang setup mo)

- Panatilihin ang `~/.openclaw/workspace` at `~/.openclaw/` bilang “mga gamit mo”; huwag ilagay ang personal na prompts/config sa `openclaw` repo.
- Pag-update ng source: `git pull` + `pnpm install` (kapag nagbago ang lockfile) + patuloy na gamitin ang `pnpm gateway:watch`.

## Linux (systemd user service)

Gumagamit ang mga Linux install ng systemd **user** service. Bilang default, pinipigilan ng systemd ang mga user service sa logout/idle, na pumapatay sa Gateway. Sinusubukan ng onboarding na i‑enable ang lingering para sa iyo (maaaring humingi ng sudo). Kung naka‑off pa rin, patakbuhin:

```bash
sudo loginctl enable-linger $USER
```

Para sa always‑on o multi‑user server, isaalang‑alang ang **system** service sa halip na user service (hindi kailangan ng lingering). Tingnan ang [Gateway runbook](/gateway) para sa mga tala sa systemd.

## Kaugnay na docs

- [Gateway runbook](/gateway) (flags, supervision, ports)
- [Gateway configuration](/gateway/configuration) (config schema + mga halimbawa)
- [Discord](/channels/discord) at [Telegram](/channels/telegram) (reply tags + replyToMode settings)
- [OpenClaw assistant setup](/start/openclaw)
- [macOS app](/platforms/macos) (gateway lifecycle)
