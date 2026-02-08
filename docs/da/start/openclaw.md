---
summary: "End-to-end-guide til at køre OpenClaw som en personlig assistent med sikkerhedsforbehold"
read_when:
  - Introduktion af en ny assistentinstans
  - Gennemgang af sikkerheds- og tilladelsesimplikationer
title: "Opsætning af personlig assistent"
x-i18n:
  source_path: start/openclaw.md
  source_hash: 8ebb0f602c074f77
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:50Z
---

# Opbygning af en personlig assistent med OpenClaw

OpenClaw er en WhatsApp + Telegram + Discord + iMessage gateway til **Pi**-agenter. Plugins tilføjer Mattermost. Denne guide er opsætningen af den “personlige assistent”: ét dedikeret WhatsApp-nummer, der opfører sig som din altid-tilgængelige agent.

## ⚠️ Sikkerhed først

Du placerer en agent i en position til at:

- køre kommandoer på din maskine (afhængigt af din Pi-værktøjsopsætning)
- læse/skrive filer i dit workspace
- sende beskeder ud via WhatsApp/Telegram/Discord/Mattermost (plugin)

Start konservativt:

- Sæt altid `channels.whatsapp.allowFrom` (kør aldrig åbent mod hele verden på din personlige Mac).
- Brug et dedikeret WhatsApp-nummer til assistenten.
- Heartbeats er nu som standard hver 30. minut. Deaktivér, indtil du har tillid til opsætningen, ved at sætte `agents.defaults.heartbeat.every: "0m"`.

## Forudsætninger

- OpenClaw installeret og onboardet — se [Kom godt i gang](/start/getting-started), hvis du ikke har gjort det endnu
- Et andet telefonnummer (SIM/eSIM/forudbetalt) til assistenten

## Opsætning med to telefoner (anbefalet)

Det her vil du have:

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

Hvis du forbinder din personlige WhatsApp til OpenClaw, bliver hver besked til dig “agent-input”. Det er sjældent, hvad du ønsker.

## 5-minutters hurtig start

1. Par WhatsApp Web (viser QR; scan med assistent-telefonen):

```bash
openclaw channels login
```

2. Start Gateway (lad den køre):

```bash
openclaw gateway --port 18789
```

3. Læg en minimal konfiguration i `~/.openclaw/openclaw.json`:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Send nu en besked til assistentnummeret fra din tilladelseslistede telefon.

Når introduktionen er færdig, åbner vi automatisk dashboardet og udskriver et rent (ikke-tokeniseret) link. Hvis den beder om auth, indsæt token fra `gateway.auth.token` i Control UI-indstillingerne. For at genåbne senere: `openclaw dashboard`.

## Giv agenten et workspace (AGENTS)

OpenClaw læser driftsinstruktioner og “hukommelse” fra sit workspace-bibliotek.

Som standard bruger OpenClaw `~/.openclaw/workspace` som agent-workspace og opretter det (plus startfilerne `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) automatisk ved opsætning/første agentkørsel. `BOOTSTRAP.md` oprettes kun, når workspace’et er helt nyt (det bør ikke komme tilbage, efter du har slettet det). `MEMORY.md` er valgfri (oprettes ikke automatisk); når den findes, indlæses den til normale sessioner. Subagent-sessioner injicerer kun `AGENTS.md` og `TOOLS.md`.

Tip: betragt denne mappe som OpenClaws “hukommelse”, og gør den til et git-repo (helst privat), så dine `AGENTS.md` + hukommelsesfiler er sikkerhedskopieret. Hvis git er installeret, initialiseres helt nye workspaces automatisk.

```bash
openclaw setup
```

Fuld workspace-struktur + backup-guide: [Agent workspace](/concepts/agent-workspace)  
Hukommelsesworkflow: [Memory](/concepts/memory)

Valgfrit: vælg et andet workspace med `agents.defaults.workspace` (understøtter `~`).

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

Hvis du allerede leverer dine egne workspace-filer fra et repo, kan du deaktivere oprettelse af bootstrap-filer helt:

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## Konfigurationen, der gør det til “en assistent”

OpenClaw har som standard en god assistentopsætning, men du vil typisk justere:

- persona/instruktioner i `SOUL.md`
- standarder for tænkning (hvis ønsket)
- heartbeats (når du har tillid til den)

Eksempel:

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

## Sessioner og hukommelse

- Sessionsfiler: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- Sessionsmetadata (tokenforbrug, seneste rute, osv.): `~/.openclaw/agents/<agentId>/sessions/sessions.json` (legacy: `~/.openclaw/sessions/sessions.json`)
- `/new` eller `/reset` starter en ny session for den chat (konfigurerbart via `resetTriggers`). Sendt alene svarer agenten med et kort hej for at bekræfte nulstillingen.
- `/compact [instructions]` komprimerer sessionskonteksten og rapporterer det resterende kontekstbudget.

## Heartbeats (proaktiv tilstand)

Som standard kører OpenClaw et heartbeat hver 30. minut med prompten:
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`  
Sæt `agents.defaults.heartbeat.every: "0m"` for at deaktivere.

- Hvis `HEARTBEAT.md` findes, men reelt er tom (kun tomme linjer og markdown-overskrifter som `# Heading`), springer OpenClaw heartbeat-kørslen over for at spare API-kald.
- Hvis filen mangler, kører heartbeat stadig, og modellen beslutter, hvad der skal gøres.
- Hvis agenten svarer med `HEARTBEAT_OK` (eventuelt med kort padding; se `agents.defaults.heartbeat.ackMaxChars`), undertrykker OpenClaw udgående levering for det heartbeat.
- Heartbeats kører fulde agent-ture — kortere intervaller bruger flere tokens.

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## Medier ind og ud

Indgående vedhæftninger (billeder/lyd/dokumenter) kan eksponeres til din kommando via skabeloner:

- `{{MediaPath}}` (lokal midlertidig filsti)
- `{{MediaUrl}}` (pseudo-URL)
- `{{Transcript}}` (hvis lydtransskription er aktiveret)

Udgående vedhæftninger fra agenten: medtag `MEDIA:<path-or-url>` på sin egen linje (ingen mellemrum). Eksempel:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw udtrækker disse og sender dem som medier sammen med teksten.

## Driftscheckliste

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

Logs ligger under `/tmp/openclaw/` (standard: `openclaw-YYYY-MM-DD.log`).

## Næste trin

- WebChat: [WebChat](/web/webchat)
- Gateway-drift: [Gateway runbook](/gateway)
- Cron + wakeups: [Cron jobs](/automation/cron-jobs)
- macOS menulinje-companion: [OpenClaw macOS-app](/platforms/macos)
- iOS node-app: [iOS-app](/platforms/ios)
- Android node-app: [Android-app](/platforms/android)
- Windows-status: [Windows (WSL2)](/platforms/windows)
- Linux-status: [Linux-app](/platforms/linux)
- Sikkerhed: [Security](/gateway/security)
