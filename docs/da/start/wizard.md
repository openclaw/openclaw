---
summary: "CLI-introduktionsguide: guidet opsætning af gateway, workspace, kanaler og skills"
read_when:
  - Kørsel eller konfiguration af introduktionsguiden
  - Opsætning af en ny maskine
title: "Introduktionsguide (CLI)"
sidebarTitle: "Onboarding: CLI"
x-i18n:
  source_path: start/wizard.md
  source_hash: 5495d951a2d78ffb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:46Z
---

# Introduktionsguide (CLI)

Introduktionsguiden er den **anbefalede** måde at sætte OpenClaw op på macOS,
Linux eller Windows (via WSL2; stærkt anbefalet).
Den konfigurerer en lokal Gateway eller en fjern Gateway-forbindelse samt kanaler, skills
og standardindstillinger for workspace i ét guidet forløb.

```bash
openclaw onboard
```

<Info>
Hurtigste første chat: åbn Control UI (ingen kanalopsætning nødvendig). Kør
`openclaw dashboard` og chat i browseren. Docs: [Dashboard](/web/dashboard).
</Info>

For at omkonfigurere senere:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` betyder ikke ikke‑interaktiv tilstand. Til scripts skal du bruge `--non-interactive`.
</Note>

<Tip>
Anbefalet: opsæt en Brave Search API-nøgle, så agenten kan bruge `web_search`
(`web_fetch` fungerer uden en nøgle). Nemste vej: `openclaw configure --section web`
som gemmer `tools.web.search.apiKey`. Docs: [Web tools](/tools/web).
</Tip>

## Hurtig start vs Avanceret

Guiden starter med **Hurtig start** (standarder) vs **Avanceret** (fuld kontrol).

<Tabs>
  <Tab title="Hurtig start (standarder)">
    - Lokal gateway (loopback)
    - Workspace-standard (eller eksisterende workspace)
    - Gateway-port **18789**
    - Gateway-autentificering **Token** (auto‑genereret, selv på loopback)
    - Tailscale-eksponering **Fra**
    - Telegram + WhatsApp DMs er som standard **tilladelsesliste** (du bliver bedt om dit telefonnummer)
  </Tab>
  <Tab title="Avanceret (fuld kontrol)">
    - Eksponerer hvert trin (tilstand, workspace, gateway, kanaler, daemon, skills).
  </Tab>
</Tabs>

## Hvad guiden konfigurerer

**Lokal tilstand (standard)** fører dig gennem disse trin:

1. **Model/Auth** — Anthropic API-nøgle (anbefalet), OAuth, OpenAI eller andre udbydere. Vælg en standardmodel.
2. **Workspace** — Placering for agentfiler (standard `~/.openclaw/workspace`). Seeder bootstrap-filer.
3. **Gateway** — Port, bind-adresse, autentificeringstilstand, Tailscale-eksponering.
4. **Kanaler** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles eller iMessage.
5. **Daemon** — Installerer en LaunchAgent (macOS) eller en systemd-brugerenhed (Linux/WSL2).
6. **Helbredstjek** — Starter Gateway og verificerer, at den kører.
7. **Skills** — Installerer anbefalede skills og valgfrie afhængigheder.

<Note>
Genkørsel af guiden sletter **intet**, medmindre du eksplicit vælger **Reset** (eller angiver `--reset`).
Hvis konfigurationen er ugyldig eller indeholder forældede nøgler, beder guiden dig om først at køre `openclaw doctor`.
</Note>

**Fjern tilstand** konfigurerer kun den lokale klient til at forbinde til en Gateway et andet sted.
Den installerer eller ændrer **ikke** noget på den fjernværtsmaskine.

## Tilføj en anden agent

Brug `openclaw agents add <name>` til at oprette en separat agent med eget workspace,
sessioner og autentificeringsprofiler. Kørsel uden `--workspace` starter guiden.

Hvad den sætter:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Noter:

- Standard-workspaces følger `~/.openclaw/workspace-<agentId>`.
- Tilføj `bindings` for at route indgående beskeder (guiden kan gøre dette).
- Ikke‑interaktive flag: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Fuld reference

For detaljerede trin-for-trin-gennemgange, ikke‑interaktiv scripting, Signal-opsætning,
RPC API og en fuld liste over konfigurationsfelter, som guiden skriver, se
[Wizard Reference](/reference/wizard).

## Relaterede docs

- CLI-kommandooversigt: [`openclaw onboard`](/cli/onboard)
- macOS-app introduktion: [Onboarding](/start/onboarding)
- Agentens første opstartsritual: [Agent Bootstrapping](/start/bootstrapping)
