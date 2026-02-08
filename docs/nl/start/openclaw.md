---
summary: "End-to-end gids voor het draaien van OpenClaw als persoonlijke assistent met veiligheidswaarschuwingen"
read_when:
  - Onboarden van een nieuwe assistent-instantie
  - Beoordelen van veiligheids- en toestemmingsimplicaties
title: "Installatie van persoonlijke assistent"
x-i18n:
  source_path: start/openclaw.md
  source_hash: 8ebb0f602c074f77
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:53Z
---

# Een persoonlijke assistent bouwen met OpenClaw

OpenClaw is een WhatsApp + Telegram + Discord + iMessage Gateway voor **Pi**-agents. Plugins voegen Mattermost toe. Deze gids beschrijft de installatie als “persoonlijke assistent”: één dedicated WhatsApp-nummer dat zich gedraagt als je altijd-aan agent.

## ⚠️ Veiligheid eerst

Je plaatst een agent in een positie om:

- opdrachten uit te voeren op je machine (afhankelijk van je Pi-toolconfiguratie)
- bestanden te lezen/schrijven in je werkruimte
- berichten terug te sturen via WhatsApp/Telegram/Discord/Mattermost (plugin)

Begin conservatief:

- Stel altijd `channels.whatsapp.allowFrom` in (draai nooit open naar de wereld op je persoonlijke Mac).
- Gebruik een dedicated WhatsApp-nummer voor de assistent.
- Heartbeat-signalen staan nu standaard op elke 30 minuten. Schakel ze uit totdat je de installatie vertrouwt door `agents.defaults.heartbeat.every: "0m"` in te stellen.

## Vereisten

- OpenClaw geïnstalleerd en geonboard — zie [Aan de slag](/start/getting-started) als je dit nog niet hebt gedaan
- Een tweede telefoonnummer (SIM/eSIM/prepaid) voor de assistent

## De twee-telefoon-installatie (aanbevolen)

Je wilt dit:

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

Als je je persoonlijke WhatsApp aan OpenClaw koppelt, wordt elk bericht aan jou “agent-input”. Dat is zelden wat je wilt.

## 5-minuten snelle start

1. Koppel WhatsApp Web (toont QR; scan met de assistent-telefoon):

```bash
openclaw channels login
```

2. Start de Gateway (laat deze draaien):

```bash
openclaw gateway --port 18789
```

3. Plaats een minimale config in `~/.openclaw/openclaw.json`:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Stuur nu een bericht naar het assistent-nummer vanaf je telefoon op de toegestane lijst.

Wanneer het onboarden is voltooid, openen we automatisch het dashboard en printen we een schone (niet-getokeniseerde) link. Als om authenticatie wordt gevraagd, plak de token uit `gateway.auth.token` in de Control UI-instellingen. Later opnieuw openen: `openclaw dashboard`.

## Geef de agent een werkruimte (AGENTS)

OpenClaw leest bedieningsinstructies en “geheugen” uit zijn werkruimtemap.

Standaard gebruikt OpenClaw `~/.openclaw/workspace` als agent-werkruimte en zal deze (plus starter `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) automatisch aanmaken bij installatie/eerste agent-run. `BOOTSTRAP.md` wordt alleen aangemaakt wanneer de werkruimte splinternieuw is (deze zou niet terug moeten komen nadat je hem hebt verwijderd). `MEMORY.md` is optioneel (niet automatisch aangemaakt); wanneer aanwezig wordt deze geladen voor normale sessies. Subagent-sessies injecteren alleen `AGENTS.md` en `TOOLS.md`.

Tip: behandel deze map als het “geheugen” van OpenClaw en maak er een git-repo van (bij voorkeur privé), zodat je `AGENTS.md` + geheugenbestanden zijn geback-upt. Als git is geïnstalleerd, worden gloednieuwe werkruimtes automatisch geïnitialiseerd.

```bash
openclaw setup
```

Volledige werkruimte-indeling + back-upgids: [Agent workspace](/concepts/agent-workspace)  
Geheugenworkflow: [Memory](/concepts/memory)

Optioneel: kies een andere werkruimte met `agents.defaults.workspace` (ondersteunt `~`).

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

Als je al je eigen werkruimtebestanden vanuit een repo levert, kun je het aanmaken van bootstrapbestanden volledig uitschakelen:

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## De config die het verandert in “een assistent”

OpenClaw heeft standaard een goede assistent-instelling, maar je wilt meestal afstemmen:

- persona/instructies in `SOUL.md`
- denk-standaardwaarden (indien gewenst)
- heartbeat-signalen (zodra je het vertrouwt)

Voorbeeld:

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## Sessies en geheugen

- Sessie-bestanden: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- Sessie-metadata (tokengebruik, laatste route, enz.): `~/.openclaw/agents/<agentId>/sessions/sessions.json` (legacy: `~/.openclaw/sessions/sessions.json`)
- `/new` of `/reset` start een nieuwe sessie voor die chat (configureerbaar via `resetTriggers`). Als dit alleen wordt verzonden, antwoordt de agent met een korte hallo om de reset te bevestigen.
- `/compact [instructions]` comprimeert de sessiecontext en rapporteert het resterende contextbudget.

## Heartbeat-signalen (proactieve modus)

Standaard draait OpenClaw elke 30 minuten een heartbeat met de prompt:
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
Stel `agents.defaults.heartbeat.every: "0m"` in om uit te schakelen.

- Als `HEARTBEAT.md` bestaat maar effectief leeg is (alleen lege regels en markdown-koppen zoals `# Heading`), slaat OpenClaw de heartbeat-run over om API-calls te besparen.
- Als het bestand ontbreekt, draait de heartbeat nog steeds en beslist het model wat te doen.
- Als de agent antwoordt met `HEARTBEAT_OK` (optioneel met korte padding; zie `agents.defaults.heartbeat.ackMaxChars`), onderdrukt OpenClaw de uitgaande levering voor die heartbeat.
- Heartbeats draaien volledige agent-beurten — kortere intervallen verbranden meer tokens.

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## Media in en uit

Inkomende bijlagen (afbeeldingen/audio/documenten) kunnen aan je opdracht worden doorgegeven via templates:

- `{{MediaPath}}` (lokaal tijdelijk bestandspad)
- `{{MediaUrl}}` (pseudo-URL)
- `{{Transcript}}` (als audiotranscriptie is ingeschakeld)

Uitgaande bijlagen van de agent: voeg `MEDIA:<path-or-url>` toe op een eigen regel (zonder spaties). Voorbeeld:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw extraheert deze en verzendt ze als media naast de tekst.

## Operationele checklist

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

Logs staan onder `/tmp/openclaw/` (standaard: `openclaw-YYYY-MM-DD.log`).

## Volgende stappen

- WebChat: [WebChat](/web/webchat)
- Gateway-operaties: [Gateway runbook](/gateway)
- Cron + wakeups: [Cron jobs](/automation/cron-jobs)
- macOS-menubalk-companion: [OpenClaw macOS app](/platforms/macos)
- iOS node-app: [iOS app](/platforms/ios)
- Android node-app: [Android app](/platforms/android)
- Windows-status: [Windows (WSL2)](/platforms/windows)
- Linux-status: [Linux app](/platforms/linux)
- Beveiliging: [Security](/gateway/security)
