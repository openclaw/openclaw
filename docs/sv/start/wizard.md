---
summary: "CLI‑introduktionsguide: guidad konfigurering av gateway, arbetsyta, kanaler och Skills"
read_when:
  - När du kör eller konfigurerar introduktionsguiden
  - När du sätter upp en ny maskin
title: "Introduktionsguide (CLI)"
sidebarTitle: "Onboarding: CLI"
---

# Introduktionsguide (CLI)

Onboarding guiden är **rekommenderas** sätt att ställa in OpenClaw på macOS,
Linux eller Windows (via WSL2; rekommenderas starkt).
Det konfigurerar en lokal Gateway eller en fjärranslutning Gateway anslutning, plus kanaler, färdigheter,
och standard arbetsyta i ett guidat flöde.

```bash
openclaw onboard
```

<Info>
Snabbaste första chatten: öppna Control UI (ingen kanal installation behövs). Kör
`openclaw dashboard` och chatta i webbläsaren. Dokument: [Dashboard](/web/dashboard).
</Info>

För att konfigurera om senare:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` innebär inte icke-interaktivt läge. För skript, använd `--non-interactive`.
</Note>

<Tip>
Rekommenderat: ställ in en modig sökAPI-nyckel så att agenten kan använda `web_search`
(`web_fetch` fungerar utan en nyckel). Lättaste sökväg: `openclaw konfigurera --section web`
som lagrar `tools.web.search.apiKey`. Dokument: [Webb verktyg](/tools/web).
</Tip>

## Snabbstart vs Avancerat

Guiden börjar med **Snabbstart** (standard) vs **Avancerat** (full kontroll).

<Tabs>
  <Tab title="QuickStart (defaults)">
    - Lokal gateway (local loopback)
    - Standardarbetsyta (eller befintlig arbetsyta)
    - Gateway‑port **18789**
    - Gateway‑autentisering **Token** (autogenererad, även på loopback)
    - Tailscale‑exponering **Av**
    - Telegram + WhatsApp‑DM:er är som standard **tillåtelselista** (du blir ombedd att ange ditt telefonnummer)
  </Tab>
  <Tab title="Advanced (full control)">
    - Exponerar varje steg (läge, arbetsyta, gateway, kanaler, daemon, Skills).
  </Tab>
</Tabs>

## Vad guiden konfigurerar

**Lokalt läge (standard)** leder dig genom följande steg:

1. **Modell/Auth** — Antropisk API-nyckel (rekommenderas), OAuth, OpenAI eller andra leverantörer. Välj en standardmodell.
2. **Arbetsyta** — Plats för agentfiler (standard `~/.openclaw/workspace`). Seeds bootstrap-filer.
3. **Gateway** — Port, bind‑adress, autentiseringsläge, Tailscale‑exponering.
4. **Kanaler** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles eller iMessage.
5. **Daemon** — Installerar en LaunchAgent (macOS) eller en systemd‑användarenhet (Linux/WSL2).
6. **Hälsokontroll** — Startar Gateway och verifierar att den körs.
7. **Skills** — Installerar rekommenderade Skills och valfria beroenden.

<Note>
Återkörning av guiden torkar **inte** om du inte uttryckligen väljer **Återställ** (eller passerar `--reset`).
Om konfigurationen är ogiltig eller innehåller äldre nycklar, ber guiden dig att köra `openclaw doctor` först.
</Note>

**Fjärrläge** konfigurerar bara den lokala klienten för att ansluta till en Gateway någon annanstans.
Det gör **inte** installera eller ändra något på fjärrvärden.

## Lägg till en annan agent

Använd `openclaw agents add <name>` för att skapa en separat agent med sin egen arbetsyta,
sessioner och auth profiler. Körs utan `--workspace` lanserar guiden.

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
