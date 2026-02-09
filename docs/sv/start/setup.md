---
summary: "Avancerad konfigurering och utvecklingsarbetsflöden för OpenClaw"
read_when:
  - Konfigurera en ny maskin
  - Du vill ha ”senaste + bästa” utan att bryta din personliga setup
title: "Konfigurering"
---

# Konfigurering

<Note>
Om du ställer in för första gången, börja med [Komma igång](/start/getting-started).
För information om guiden, se [Onboarding Wizard](/start/wizard).
</Note>

Senast uppdaterad: 2026-01-01

## TL;DR

- **Anpassning ligger utanför repot:** `~/.openclaw/workspace` (workspace) + `~/.openclaw/openclaw.json` (konfig).
- **Stabilt arbetsflöde:** installera macOS-appen; låt den köra den medföljande Gateway.
- **Bleeding edge-arbetsflöde:** kör Gateway själv via `pnpm gateway:watch`, och låt sedan macOS-appen ansluta i lokalt läge.

## Förutsättningar (från källkod)

- Node `>=22`
- `pnpm`
- Docker (valfritt; endast för containeriserad setup/e2e — se [Docker](/install/docker))

## Anpassningsstrategi (så uppdateringar inte gör ont)

Om du vill ha ”100 % anpassat för mig” _och_ enkla uppdateringar, behåll din anpassning i:

- **Konfig:** `~/.openclaw/openclaw.json` (JSON/JSON5‑likt)
- **Workspace:** `~/.openclaw/workspace` (Skills, prompts, minnen; gör det till ett privat git‑repo)

Bootstrap en gång:

```bash
openclaw setup
```

Från insidan av detta repo, använd den lokala CLI‑ingången:

```bash
openclaw setup
```

Om du inte har en global installation ännu, kör den via `pnpm openclaw setup`.

## Kör Gateway från detta repo

Efter `pnpm build` kan du köra den paketerade CLI:n direkt:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Stabilt arbetsflöde (macOS‑appen först)

1. Installera + starta **OpenClaw.app** (menyraden).
2. Slutför introduktions-/behörighetschecklistan (TCC‑prompter).
3. Säkerställ att Gateway är **Local** och körs (appen hanterar den).
4. Länka ytor (exempel: WhatsApp):

```bash
openclaw channels login
```

5. Rimlighetskontroll:

```bash
openclaw health
```

Om introduktionen inte är tillgänglig i din build:

- Kör `openclaw setup`, sedan `openclaw channels login`, och starta därefter Gateway manuellt (`openclaw gateway`).

## Bleeding edge‑arbetsflöde (Gateway i en terminal)

Mål: arbeta på TypeScript‑Gateway, få hot reload, behåll macOS‑appens UI anslutet.

### 0. (Valfritt) Kör macOS‑appen från källkod också

Om du även vill ha macOS‑appen på bleeding edge:

```bash
./scripts/restart-mac.sh
```

### 1. Starta dev‑Gateway

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` kör gateway i watch‑läge och laddar om vid TypeScript‑ändringar.

### 2. Peka macOS‑appen mot din körande Gateway

I **OpenClaw.app**:

- Anslutningsläge: **Local**
  Appen ansluter till den körande gatewayn på den konfigurerade porten.

### 3. Verifiera

- Gateway‑status i appen ska visa **”Using existing gateway …”**
- Eller via CLI:

```bash
openclaw health
```

### Vanliga fallgropar

- **Fel port:** Gateway WS har standard `ws://127.0.0.1:18789`; håll app + CLI på samma port.
- **Var tillstånd lagras:**
  - Autentiseringsuppgifter: `~/.openclaw/credentials/`
  - Sessioner: `~/.openclaw/agents/<agentId>/sessions/`
  - Loggar: `/tmp/openclaw/`

## Karta över lagring av autentiseringsuppgifter

Använd detta vid felsökning av autentisering eller när du bestämmer vad som ska säkerhetskopieras:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**: konfig/env eller `channels.telegram.tokenFile`
- **Discord bot token**: konfig/env (tokenfil stöds ännu inte)
- **Slack‑tokens**: konfig/env (`channels.slack.*`)
- **Parnings‑tillåtelselistor**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **Autentiseringsprofiler för modeller**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **Import av legacy OAuth**: `~/.openclaw/credentials/oauth.json`
  Mer detaljer: [Security](/gateway/security#credential-storage-map).

## Uppdatering (utan att förstöra din setup)

- Behåll `~/.openclaw/workspace` och `~/.openclaw/` som ”ditt”; lägg inte personliga prompts/konfig i `openclaw`‑repot.
- Uppdatera källkod: `git pull` + `pnpm install` (när lockfilen ändras) + fortsätt använda `pnpm gateway:watch`.

## Linux (systemd användartjänst)

Linux installerar använder en systemd **användare** tjänst. Som standard stoppar systemd användare
tjänster på utloggning/inaktiv, vilket dödar Gateway. Onboarding försök att aktivera
kvardröjande för dig (kan fråga om sudo). Om det fortfarande är borta, köra:

```bash
sudo loginctl enable-linger $USER
```

För alltid på eller multi-user servrar, överväga ett **system** tjänst istället för en
användartjänst (ingen kvardröjande behövs). Se [Gateway runbook](/gateway) för systemd-anteckningarna.

## Relaterad dokumentation

- [Gateway runbook](/gateway) (flaggor, övervakning, portar)
- [Gateway‑konfiguration](/gateway/configuration) (konfigschema + exempel)
- [Discord](/channels/discord) och [Telegram](/channels/telegram) (svarstaggar + replyToMode‑inställningar)
- [OpenClaw assistant setup](/start/openclaw)
- [macOS‑app](/platforms/macos) (gatewayns livscykel)
