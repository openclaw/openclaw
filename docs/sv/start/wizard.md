---
summary: "CLI‑introduktionsguide: guidad konfigurering av gateway, arbetsyta, kanaler och Skills"
read_when:
  - När du kör eller konfigurerar introduktionsguiden
  - När du sätter upp en ny maskin
title: "Introduktionsguide (CLI)"
sidebarTitle: "Onboarding: CLI"
x-i18n:
  source_path: start/wizard.md
  source_hash: 5495d951a2d78ffb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:37Z
---

# Introduktionsguide (CLI)

Introduktionsguiden är det **rekommenderade** sättet att konfigurera OpenClaw på macOS,
Linux eller Windows (via WSL2; starkt rekommenderat).
Den konfigurerar en lokal Gateway eller en fjärranslutning till en Gateway, samt kanaler, Skills
och standarder för arbetsytan i ett enda guidad flöde.

```bash
openclaw onboard
```

<Info>
Snabbaste första chatten: öppna Control UI (ingen kanalinställning behövs). Kör
`openclaw dashboard` och chatta i webbläsaren. Dokumentation: [Dashboard](/web/dashboard).
</Info>

För att konfigurera om senare:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` innebär inte icke‑interaktivt läge. För skript, använd `--non-interactive`.
</Note>

<Tip>
Rekommenderat: konfigurera en Brave Search API‑nyckel så att agenten kan använda `web_search`
(`web_fetch` fungerar utan nyckel). Enklaste vägen: `openclaw configure --section web`
som lagrar `tools.web.search.apiKey`. Dokumentation: [Web tools](/tools/web).
</Tip>

## Snabbstart vs Avancerat

Guiden börjar med **Snabbstart** (standard) vs **Avancerat** (full kontroll).

<Tabs>
  <Tab title="Snabbstart (standard)">
    - Lokal gateway (local loopback)
    - Standardarbetsyta (eller befintlig arbetsyta)
    - Gateway‑port **18789**
    - Gateway‑autentisering **Token** (autogenererad, även på loopback)
    - Tailscale‑exponering **Av**
    - Telegram + WhatsApp‑DM:er är som standard **tillåtelselista** (du blir ombedd att ange ditt telefonnummer)
  </Tab>
  <Tab title="Avancerat (full kontroll)">
    - Exponerar varje steg (läge, arbetsyta, gateway, kanaler, daemon, Skills).
  </Tab>
</Tabs>

## Vad guiden konfigurerar

**Lokalt läge (standard)** leder dig genom följande steg:

1. **Modell/Autentisering** — Anthropic API‑nyckel (rekommenderas), OAuth, OpenAI eller andra leverantörer. Välj en standardmodell.
2. **Arbetsyta** — Plats för agentfiler (standard `~/.openclaw/workspace`). Skapar bootstrap‑filer.
3. **Gateway** — Port, bind‑adress, autentiseringsläge, Tailscale‑exponering.
4. **Kanaler** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles eller iMessage.
5. **Daemon** — Installerar en LaunchAgent (macOS) eller en systemd‑användarenhet (Linux/WSL2).
6. **Hälsokontroll** — Startar Gateway och verifierar att den körs.
7. **Skills** — Installerar rekommenderade Skills och valfria beroenden.

<Note>
Att köra guiden igen raderar **inget** om du inte uttryckligen väljer **Återställ** (eller skickar `--reset`).
Om konfigen är ogiltig eller innehåller äldre nycklar ber guiden dig att först köra `openclaw doctor`.
</Note>

**Fjärrläge** konfigurerar endast den lokala klienten för att ansluta till en Gateway någon annanstans.
Det installerar eller ändrar **inget** på fjärrvärden.

## Lägg till en annan agent

Använd `openclaw agents add <name>` för att skapa en separat agent med egen arbetsyta,
sessioner och autentiseringsprofiler. Körning utan `--workspace` startar guiden.

Vad den sätter:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Noteringar:

- Standardarbetsytor följer `~/.openclaw/workspace-<agentId>`.
- Lägg till `bindings` för att routa inkommande meddelanden (guiden kan göra detta).
- Icke‑interaktiva flaggor: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Fullständig referens

För detaljerade steg‑för‑steg‑genomgångar, icke‑interaktiv skriptning, Signal‑konfigurering,
RPC‑API och en fullständig lista över konfigfält som guiden skriver, se
[Guide‑referens](/reference/wizard).

## Relaterad dokumentation

- Referens för CLI‑kommandon: [`openclaw onboard`](/cli/onboard)
- Introduktion för macOS‑appen: [Onboarding](/start/onboarding)
- Agentens första körning: [Agent Bootstrapping](/start/bootstrapping)
