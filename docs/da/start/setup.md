---
summary: "Avanceret opsætning og udviklingsworkflows til OpenClaw"
read_when:
  - Opsætning af en ny maskine
  - Du vil have “latest + greatest” uden at ødelægge din personlige opsætning
title: "Opsætning"
---

# Opsætning

<Note>
Hvis du opsætter for første gang, så start med [Kom i gang](/start/getting-started).
For guiden detaljer, se [Onboarding Wizard](/start/wizard).
</Note>

Sidst opdateret: 2026-01-01

## TL;DR

- **Tilpasning lever uden for repoet:** `~/.openclaw/workspace` (workspace) + `~/.openclaw/openclaw.json` (konfiguration).
- **Stabilt workflow:** installér macOS-appen; lad den køre den medfølgende Gateway.
- **Bleeding edge-workflow:** kør Gateway selv via `pnpm gateway:watch`, og lad derefter macOS-appen forbinde i Lokal-tilstand.

## Forudsætninger (fra kilde)

- Node `>=22`
- `pnpm`
- Docker (valgfrit; kun til containeriseret opsætning/e2e — se [Docker](/install/docker))

## Strategi for tilpasning (så opdateringer ikke gør ondt)

Hvis du vil have “100 % tilpasset til mig” _og_ nemme opdateringer, så behold din tilpasning i:

- **Konfiguration:** `~/.openclaw/openclaw.json` (JSON/JSON5-agtigt)
- **Workspace:** `~/.openclaw/workspace` (skills, prompts, memories; gør det til et privat git-repo)

Bootstrap én gang:

```bash
openclaw setup
```

Inde fra dette repo, brug den lokale CLI-indgang:

```bash
openclaw setup
```

Hvis du ikke har en global installation endnu, så kør den via `pnpm openclaw setup`.

## Kør Gateway fra dette repo

Efter `pnpm build` kan du køre den pakkede CLI direkte:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Stabilt workflow (macOS-app først)

1. Installér + start **OpenClaw.app** (menulinjen).
2. Gennemfør onboarding-/tilladelses-tjeklisten (TCC-prompter).
3. Sørg for, at Gateway er **Lokal** og kører (appen styrer den).
4. Knyt flader (eksempel: WhatsApp):

```bash
openclaw channels login
```

5. Sanity check:

```bash
openclaw health
```

Hvis onboarding ikke er tilgængelig i dit build:

- Kør `openclaw setup`, derefter `openclaw channels login`, og start så Gateway manuelt (`openclaw gateway`).

## Bleeding edge-workflow (Gateway i en terminal)

Mål: arbejd på TypeScript-Gateway, få hot reload, og behold macOS-appens UI tilsluttet.

### 0. (Valgfrit) Kør også macOS-appen fra kilde

Hvis du også vil have macOS-appen på bleeding edge:

```bash
./scripts/restart-mac.sh
```

### 1. Start dev-Gateway

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` kører gatewayen i watch-tilstand og genindlæser ved TypeScript-ændringer.

### 2. Peg macOS-appen på din kørende Gateway

I **OpenClaw.app**:

- Connection Mode: **Local**
  Appen vil forbinde til den kørende gateway på den konfigurerede port.

### 3. Verificér

- Gateway-status i appen bør vise **“Using existing gateway …”**
- Eller via CLI:

```bash
openclaw health
```

### Almindelige faldgruber

- **Forkert port:** Gateway WS er som standard `ws://127.0.0.1:18789`; hold app + CLI på samme port.
- **Hvor tilstand ligger:**
  - Legitimationsoplysninger: `~/.openclaw/credentials/`
  - Sessioner: `~/.openclaw/agents/<agentId>/sessions/`
  - Logs: `/tmp/openclaw/`

## Kort over lagring af legitimationsoplysninger

Brug dette ved fejlfinding af auth eller når du beslutter, hvad der skal sikkerhedskopieres:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot-token**: konfiguration/miljøvariabler eller `channels.telegram.tokenFile`
- **Discord bot-token**: konfiguration/miljøvariabler (tokenfil understøttes endnu ikke)
- **Slack-tokens**: konfiguration/miljøvariabler (`channels.slack.*`)
- **Pairing-tilladelseslister**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **Model-auth-profiler**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **Legacy OAuth-import**: `~/.openclaw/credentials/oauth.json`
  Flere detaljer: [Sikkerhed](/gateway/security#credential-storage-map).

## Opdatering (uden at smadre din opsætning)

- Behold `~/.openclaw/workspace` og `~/.openclaw/` som “dit indhold”; læg ikke personlige prompts/konfiguration i `openclaw`-repoet.
- Opdatering af kilde: `git pull` + `pnpm install` (når lockfile er ændret) + fortsæt med at bruge `pnpm gateway:watch`.

## Linux (systemd user service)

Linux installerer bruge en systemd \*\* bruger\*\* tjeneste. Som standard stopper systemd bruger
tjenester på logout/idle, som dræber Gateway. Onboarding forsøger at aktivere
dvæle for dig (kan bede om sudo). Hvis det stadig er slukket, køre:

```bash
sudo loginctl enable-linger $USER
```

For always-on eller multi-user servere, overvej en **system** service i stedet for en
brugerservice (ingen dingering nødvendig). Se [Gateway runbook](/gateway) for systemd noter.

## Relaterede dokumenter

- [Gateway runbook](/gateway) (flag, overvågning, porte)
- [Gateway-konfiguration](/gateway/configuration) (konfigurationsskema + eksempler)
- [Discord](/channels/discord) og [Telegram](/channels/telegram) (reply-tags + replyToMode-indstillinger)
- [OpenClaw-assistentopsætning](/start/openclaw)
- [macOS-app](/platforms/macos) (gateway-livscyklus)
