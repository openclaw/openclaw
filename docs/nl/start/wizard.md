---
summary: "CLI-onboardingwizard: begeleide installatie voor Gateway, werkruimte, kanalen en skills"
read_when:
  - Het uitvoeren of configureren van de onboardingwizard
  - Het instellen van een nieuwe machine
title: "Onboardingwizard (CLI)"
sidebarTitle: "Onboarding: CLI"
---

# Onboardingwizard (CLI)

De onboardingwizard is de **aanbevolen** manier om OpenClaw in te stellen op macOS,
Linux of Windows (via WSL2; sterk aanbevolen).
Hij configureert een lokale Gateway of een externe Gateway-verbinding, plus kanalen, skills
en werkruimte-standaardinstellingen in één begeleide flow.

```bash
openclaw onboard
```

<Info>
Snelste eerste chat: open de Control UI (geen kanaalinstelling nodig). Voer uit
`openclaw dashboard` en chat in de browser. Documentatie: [Dashboard](/web/dashboard).
</Info>

Later opnieuw configureren:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` impliceert geen niet-interactieve modus. Gebruik voor scripts `--non-interactive`.
</Note>

<Tip>
Aanbevolen: stel een Brave Search API-sleutel in zodat de agent `web_search` kan gebruiken
(`web_fetch` werkt zonder sleutel). Makkelijkste route: `openclaw configure --section web`
waarmee `tools.web.search.apiKey` wordt opgeslagen. Documentatie: [Web tools](/tools/web).
</Tip>

## QuickStart vs Advanced

De wizard start met **QuickStart** (standaardwaarden) versus **Advanced** (volledige controle).

<Tabs>
  <Tab title="QuickStart (defaults)">
    - Lokale Gateway (loopback)
    - Werkruimte-standaard (of bestaande werkruimte)
    - Gateway-poort **18789**
    - Gateway-auth **Token** (automatisch gegenereerd, zelfs op loopback)
    - Tailscale-blootstelling **Uit**
    - Telegram + WhatsApp-DM's staan standaard op **toegestane lijst** (je wordt gevraagd om je telefoonnummer)
  </Tab>
  <Tab title="Advanced (full control)">
    - Toont elke stap (modus, werkruimte, Gateway, kanalen, daemon, skills).
  </Tab>
</Tabs>

## Wat de wizard configureert

**Lokale modus (standaard)** leidt je door deze stappen:

1. **Model/Auth** — Anthropic API-sleutel (aanbevolen), OAuth, OpenAI of andere providers. Kies een standaardmodel.
2. **Werkruimte** — Locatie voor agentbestanden (standaard `~/.openclaw/workspace`). Zaait bootstrapbestanden.
3. **Gateway** — Poort, bind-adres, auth-modus, Tailscale-blootstelling.
4. **Kanalen** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles of iMessage.
5. **Daemon** — Installeert een LaunchAgent (macOS) of systemd user unit (Linux/WSL2).
6. **Health check** — Start de Gateway en verifieert dat deze draait.
7. **Skills** — Installeert aanbevolen skills en optionele afhankelijkheden.

<Note>
Het opnieuw uitvoeren van de wizard wist **niets**, tenzij je expliciet **Reset** kiest (of `--reset` meegeeft).
Als de config ongeldig is of verouderde sleutels bevat, vraagt de wizard je eerst `openclaw doctor` uit te voeren.
</Note>

**Externe modus** configureert alleen de lokale client om verbinding te maken met een Gateway elders.
Er wordt **niets** geïnstalleerd of gewijzigd op de externe host.

## Nog een agent toevoegen

Gebruik `openclaw agents add <name>` om een aparte agent te maken met een eigen werkruimte,
sessies en auth-profielen. Uitvoeren zonder `--workspace` start de wizard.

Wat het instelt:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

Notities:

- Standaardwerkruimtes volgen `~/.openclaw/workspace-<agentId>`.
- Voeg `bindings` toe om inkomende berichten te routeren (de wizard kan dit doen).
- Niet-interactieve flags: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## Volledige referentie

Voor gedetailleerde stap-voor-stapbeschrijvingen, niet-interactieve scripting, Signal-instelling,
RPC API en een volledige lijst van configvelden die de wizard wegschrijft, zie de
[Wizard Reference](/reference/wizard).

## Gerelateerde documentatie

- CLI-opdrachtenreferentie: [`openclaw onboard`](/cli/onboard)
- macOS-app onboarding: [Onboarding](/start/onboarding)
- Agent first-run-ritueel: [Agent Bootstrapping](/start/bootstrapping)
