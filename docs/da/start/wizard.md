---
summary: "CLI-introduktionsguide: guidet opsætning af gateway, workspace, kanaler og skills"
read_when:
  - Kørsel eller konfiguration af introduktionsguiden
  - Opsætning af en ny maskine
title: "Introduktionsguide (CLI)"
sidebarTitle: "Onboarding: CLI"
---

# Introduktionsguide (CLI)

Onboarding-guiden er den **anbefalede** måde at oprette OpenClaw på macOS,
Linux eller Windows (via WSL2; anbefales kraftigt).
Det konfigurerer en lokal Gateway eller en ekstern Gateway forbindelse, plus kanaler, færdigheder,
og arbejdsområde standarder i en guidet flow.

```bash
openclaw onboard
```

<Info>
Hurtigste første chat: åbne Control UI (ingen kanal setup nødvendig). Kør
'openclaw dashboard' og chat i browseren. Dokumenter: [Dashboard](/web/dashboard).
</Info>

For at omkonfigurere senere:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` betyder ikke ikke-interaktiv tilstand. For scripts, brug `--non-interactive`.
</Note>

<Tip>
Anbefalet: opsæt en modig søgning API-nøgle, så agenten kan bruge `web_search`
(`web_fetch` fungerer uden en nøgle). Nemmeste sti: `openclaw configure --section web`
som gemmer `tools.web.search.apiKey`. Docs: [Webværktøjer] (/tools/web).
</Tip>

## Hurtig start vs Avanceret

Guiden starter med **Hurtig start** (standarder) vs **Avanceret** (fuld kontrol).

<Tabs>
  <Tab title="QuickStart (defaults)">
    - Lokal gateway (loopback)
    - Workspace-standard (eller eksisterende workspace)
    - Gateway-port **18789**
    - Gateway-autentificering **Token** (auto‑genereret, selv på loopback)
    - Tailscale-eksponering **Fra**
    - Telegram + WhatsApp DMs er som standard **tilladelsesliste** (du bliver bedt om dit telefonnummer)
  </Tab>
  <Tab title="Advanced (full control)">
    - Eksponerer hvert trin (tilstand, workspace, gateway, kanaler, daemon, skills).
  </Tab>
</Tabs>

## Hvad guiden konfigurerer

**Lokal tilstand (standard)** fører dig gennem disse trin:

1. **Model/Auth** — Antropisk API-nøgle (anbefales), OAuth, OpenAI eller andre udbydere. Vælg en standardmodel.
2. **Arbejdsrum** — Placering af agentfiler (standard `~/.openclaw/workspace`). Seeds bootstrap filer.
3. **Gateway** — Port, bind-adresse, autentificeringstilstand, Tailscale-eksponering.
4. **Kanaler** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles eller iMessage.
5. **Daemon** — Installerer en LaunchAgent (macOS) eller en systemd-brugerenhed (Linux/WSL2).
6. **Helbredstjek** — Starter Gateway og verificerer, at den kører.
7. **Skills** — Installerer anbefalede skills og valgfrie afhængigheder.

<Note>
Genkørende guiden gør **ikke** sletning af noget, medmindre du eksplicit vælger **Nulstil** (eller pass `--reset`).
Hvis config er ugyldig eller indeholder ældre nøgler, beder guiden dig om at køre `openclaw doctor` først.
</Note>

**Fjerntilstand** konfigurerer kun den lokale klient til at forbinde til en Gateway andetsteds.
Det gør **ikke** installere eller ændre noget på den eksterne vært.

## Tilføj en anden agent

Brug `openclaw agenter add <name>` for at oprette en separat agent med sit eget arbejdsområde,
sessioner og auth profiler. Kører uden `-- workspace` starter guiden.

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
