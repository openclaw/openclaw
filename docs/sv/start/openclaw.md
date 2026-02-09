---
summary: "Guide från start till mål för att köra OpenClaw som en personlig assistent med säkerhetsvarningar"
read_when:
  - Introduktion av en ny assistentinstans
  - Granskning av säkerhets- och behörighetsimplikationer
title: "Konfigurering av personlig assistent"
---

# Bygga en personlig assistent med OpenClaw

OpenClaw är en WhatsApp + Telegram + Discord + iMessage gateway för **Pi** agenter. Tillägg till Mattermost. Denna guide är "personlig assistent" setup: en dedikerad WhatsApp nummer som beter sig som din alltid ombud.

## ⚠️ Säkerhet först

Du placerar en agent i en position att:

- köra kommandon på din maskin (beroende på din Pi-verktygskonfiguration)
- läsa/skriva filer i din arbetsyta
- skicka meddelanden vidare via WhatsApp/Telegram/Discord/Mattermost (plugin)

Börja försiktigt:

- Sätt alltid `channels.whatsapp.allowFrom` (kör aldrig öppet mot hela världen på din personliga Mac).
- Använd ett dedikerat WhatsApp-nummer för assistenten.
- Heartbeats är nu standard för var 30:e minut. Inaktivera tills du litar på installationen genom att ställa in `agents.defaults.heartbeat.every: "0m"`.

## Förutsättningar

- OpenClaw installerat och introducerat — se [Kom igång](/start/getting-started) om du inte har gjort detta än
- Ett andra telefonnummer (SIM/eSIM/kontantkort) för assistenten

## Tvåtelefonersuppsättningen (rekommenderas)

Du vill ha detta:

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

Om du länkar din personliga WhatsApp till OpenClaw, varje meddelande till dig blir “agent input”. Det är sällan det du vill.

## Snabbstart på 5 minuter

1. Para WhatsApp Web (visar QR; skanna med assistenttelefonen):

```bash
openclaw channels login
```

2. Starta Gateway (låt den vara igång):

```bash
openclaw gateway --port 18789
```

3. Lägg in en minimal konfig i `~/.openclaw/openclaw.json`:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Meddela nu assistentnumret från din tillåtelselista.

När onboarding är klar öppnar vi instrumentbrädan automatiskt och skriver ut en ren (icke-tokenized) länk. Om det ber om att få auth, klistra in token från `gateway.auth.token` i kontrollgränssnittets inställningar. För att öppna senare: `openclaw dashboard`.

## Ge agenten en arbetsyta (AGENTS)

OpenClaw läser driftinstruktioner och ”minne” från sin arbetsytekatalog.

Som standard använder OpenClaw `~/.openclaw/workspace` som agentens arbetsyta, och kommer att skapa det (plus start-`AGENTS. d`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) automatiskt vid setup/första agent kör. `BOOTSTRAP.md` skapas bara när arbetsytan är helt ny (det bör inte komma tillbaka efter att du tagit bort den). `MEMORY.md` är valfritt (inte automatiskt skapat); när närvarande, är det laddat för normala sessioner. Underagent sessioner endast injicera `AGENTS.md` och `TOOLS.md`.

Tips: behandla den här mappen som OpenClaws ”minne” och gör den till en git repo (helst privat) så att dina `AGENTS.md` + minnesfiler säkerhetskopieras. Om git är installerat är helt nya arbetsytor autoinitierade.

```bash
openclaw setup
```

Fullständig arbetsytestruktur + guide för säkerhetskopiering: [Agent workspace](/concepts/agent-workspace)  
Minnesarbetsflöde: [Memory](/concepts/memory)

Valfritt: välj en annan arbetsyta med `agents.defaults.workspace` (stödjer `~`).

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

Om du redan levererar dina egna arbetsytefiler från ett repo kan du inaktivera skapandet av bootstrap‑filer helt:

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## Konfigen som gör den till ”en assistent”

OpenClaw har som standard en bra assistentuppsättning, men du vill oftast justera:

- persona/instruktioner i `SOUL.md`
- tänkandeförval (om önskat)
- heartbeats (när du väl litar på den)

Exempel:

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

## Sessioner och minne

- Sessionsfiler: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- Sessionsmetadata (tokenanvändning, senaste rutt, etc): `~/.openclaw/agents/<agentId>/sessions/sessions.json` (legacy: `~/.openclaw/sessions/sessions.json`)
- `/new` eller `/reset` startar en ny session för den chatten (konfigurerbar via `resetTriggers`). Om den skickas ensam, svarar agenten med en kort hej för att bekräfta återställningen.
- `/compact [instructions]` komprimerar sessionskontexten och rapporterar återstående kontextbudget.

## Heartbeats (proaktivt läge)

Som standard kör OpenClaw ett hjärtslag var 30:e minut med prompten:
`Read HEARTBEAT.md om det finns (arbetsytans sammanhang). Följ den strikt. Sluta inte eller upprepa gamla uppgifter från tidigare chattar. Om inget behöver uppmärksamhet, svara HEARTBEAT_OK.`
Set `agents.defaults.heartbeat.every: "0m"` för att inaktivera.

- Om `HEARTBEAT.md` finns men i praktiken är tom (endast tomma rader och markdown‑rubriker som `# Heading`), hoppar OpenClaw över heartbeat‑körningen för att spara API‑anrop.
- Om filen saknas körs heartbeat ändå och modellen avgör vad som ska göras.
- Om agenten svarar med `HEARTBEAT_OK` (valfritt med kort utfyllnad; se `agents.defaults.heartbeat.ackMaxChars`), undertrycker OpenClaw utgående leverans för den heartbeaten.
- Heartbeats kör fullständiga agentvarv — kortare intervall förbrukar fler tokens.

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## Media in och ut

Inkommande bilagor (bilder/ljud/dokument) kan exponeras till ditt kommando via mallar:

- `{{MediaPath}}` (lokal temporär filsökväg)
- `{{MediaUrl}}` (pseudo‑URL)
- `{{Transcript}}` (om ljudtranskribering är aktiverad)

Utgående bilagor från agenten: inkludera `MEDIA:<path-or-url>` på sin egen linje (inga mellanslag). Exempel:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw extraherar dessa och skickar dem som media tillsammans med texten.

## Driftchecklista

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

Loggar finns under `/tmp/openclaw/` (standard: `openclaw-YYYY-MM-DD.log`).

## Nästa steg

- WebChat: [WebChat](/web/webchat)
- Gateway‑drift: [Gateway runbook](/gateway)
- Cron + väckningar: [Cron jobs](/automation/cron-jobs)
- macOS‑menyradskompanjon: [OpenClaw macOS app](/platforms/macos)
- iOS‑nodeapp: [iOS app](/platforms/ios)
- Android‑nodeapp: [Android app](/platforms/android)
- Windows‑status: [Windows (WSL2)](/platforms/windows)
- Linux‑status: [Linux app](/platforms/linux)
- Säkerhet: [Security](/gateway/security)
