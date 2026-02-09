---
summary: "Geavanceerde installatie- en ontwikkelworkflows voor OpenClaw"
read_when:
  - Een nieuwe machine instellen
  - Je wilt “latest + greatest” zonder je persoonlijke setup te breken
title: "Installatie"
---

# Installatie

<Note>
Als je voor het eerst instelt, begin met [Aan de slag](/start/getting-started).
Voor wizarddetails, zie [Onboarding Wizard](/start/wizard).
</Note>

Laatst bijgewerkt: 2026-01-01

## TL;DR

- **Aanpassing leeft buiten de repo:** `~/.openclaw/workspace` (werkruimte) + `~/.openclaw/openclaw.json` (config).
- **Stabiele workflow:** installeer de macOS-app; laat deze de gebundelde Gateway draaien.
- **Bleeding edge-workflow:** draai de Gateway zelf via `pnpm gateway:watch`, en laat vervolgens de macOS-app in Lokale modus koppelen.

## Vereisten (van bron)

- Node `>=22`
- `pnpm`
- Docker (optioneel; alleen voor containerized setup/e2e — zie [Docker](/install/docker))

## Strategie voor maatwerk (zodat updates geen pijn doen)

Als je “100% op mij afgestemd” _en_ eenvoudige updates wilt, houd je aanpassingen in:

- **Config:** `~/.openclaw/openclaw.json` (JSON/JSON5-achtig)
- **Werkruimte:** `~/.openclaw/workspace` (Skills, prompts, herinneringen; maak er een private git-repo van)

Eenmalig bootstrappen:

```bash
openclaw setup
```

Gebruik vanuit deze repo de lokale CLI-ingang:

```bash
openclaw setup
```

Als je nog geen globale installatie hebt, voer het uit via `pnpm openclaw setup`.

## Draai de Gateway vanuit deze repo

Na `pnpm build` kun je de verpakte CLI direct uitvoeren:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Stabiele workflow (macOS-app eerst)

1. Installeer + start **OpenClaw.app** (menubalk).
2. Rond de onboarding-/rechtenchecklist af (TCC-prompts).
3. Zorg dat de Gateway **Local** is en draait (de app beheert dit).
4. Koppel surfaces (voorbeeld: WhatsApp):

```bash
openclaw channels login
```

5. Sanity controle:

```bash
openclaw health
```

Als onboarding niet beschikbaar is in jouw build:

- Voer `openclaw setup` uit, daarna `openclaw channels login`, en start vervolgens de Gateway handmatig (`openclaw gateway`).

## Bleeding edge-workflow (Gateway in een terminal)

Doel: werken aan de TypeScript-Gateway, hot reload krijgen en de macOS-app-UI gekoppeld houden.

### 0. (Optioneel) Draai ook de macOS-app vanuit bron

Als je ook de macOS-app op bleeding edge wilt:

```bash
./scripts/restart-mac.sh
```

### 1. Start de dev Gateway

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` draait de gateway in watch-modus en herlaadt bij TypeScript-wijzigingen.

### 2. Richt de macOS-app op je draaiende Gateway

In **OpenClaw.app**:

- Verbindingsmodus: **Local**
  De app koppelt aan de draaiende gateway op de geconfigureerde poort.

### 3. Verifiëren

- De Gateway-status in de app moet **“Using existing gateway …”** tonen
- Of via CLI:

```bash
openclaw health
```

### Gemeenschappelijke voetgeweers

- **Verkeerde poort:** Gateway WS staat standaard op `ws://127.0.0.1:18789`; houd app + CLI op dezelfde poort.
- **Waar staat de status:**
  - Referenties: `~/.openclaw/credentials/`
  - Sessies: `~/.openclaw/agents/<agentId>/sessions/`
  - Logs: `/tmp/openclaw/`

## Opslagkaart voor referenties

Gebruik dit bij het debuggen van authenticatie of om te bepalen wat je moet back-uppen:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot-token**: config/env of `channels.telegram.tokenFile`
- **Discord bot-token**: config/env (tokenbestand nog niet ondersteund)
- **Slack-tokens**: config/env (`channels.slack.*`)
- **Pairing allowlists**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **Model-authprofielen**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **Legacy OAuth-import**: `~/.openclaw/credentials/oauth.json`
  Meer details: [Beveiliging](/gateway/security#credential-storage-map).

## Updaten (zonder je setup te slopen)

- Houd `~/.openclaw/workspace` en `~/.openclaw/` als “jouw spullen”; zet geen persoonlijke prompts/config in de `openclaw`-repo.
- Bron bijwerken: `git pull` + `pnpm install` (wanneer het lockfile is gewijzigd) + blijf `pnpm gateway:watch` gebruiken.

## Linux (systemd user service)

Linux-installaties gebruiken een systemd **user** service. Standaard stopt systemd user-
services bij uitloggen/inactiviteit, wat de Gateway stopt. Onboarding probeert
lingering voor je in te schakelen (kan om sudo vragen). Als het nog steeds uit staat, voer uit:

```bash
sudo loginctl enable-linger $USER
```

Voor always-on of multi-user servers kun je een **system** service overwegen in plaats van een
user service (geen lingering nodig). Zie het [Gateway-runbook](/gateway) voor de systemd-notities.

## Gerelateerde documentatie

- [Gateway-runbook](/gateway) (flags, supervisie, poorten)
- [Gateway-configuratie](/gateway/configuration) (configschema + voorbeelden)
- [Discord](/channels/discord) en [Telegram](/channels/telegram) (reply-tags + replyToMode-instellingen)
- [OpenClaw-assistent installatie](/start/openclaw)
- [macOS-app](/platforms/macos) (gateway-levenscyclus)
