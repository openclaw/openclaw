---
summary: "Agent-runtime (indlejret pi-mono), workspace-kontrakt og session-bootstrap"
read_when:
  - Ændring af agent-runtime, workspace-bootstrap eller sessionsadfærd
title: "Agent Runtime"
x-i18n:
  source_path: concepts/agent.md
  source_hash: 121103fda29a5481
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:16Z
---

# Agent Runtime 🤖

OpenClaw kører en enkelt indlejret agent-runtime afledt af **pi-mono**.

## Workspace (påkrævet)

OpenClaw bruger én agent-workspace-mappe (`agents.defaults.workspace`) som agentens **eneste** arbejdsmappe (`cwd`) for værktøjer og kontekst.

Anbefalet: brug `openclaw setup` til at oprette `~/.openclaw/openclaw.json`, hvis den mangler, og initialisér workspace-filerne.

Fuld workspace-layout + backup-guide: [Agent workspace](/concepts/agent-workspace)

Hvis `agents.defaults.sandbox` er aktiveret, kan ikke-hovedsessioner tilsidesætte dette med
per-session workspaces under `agents.defaults.sandbox.workspaceRoot` (se
[Gateway-konfiguration](/gateway/configuration)).

## Bootstrap-filer (injekteret)

Inde i `agents.defaults.workspace` forventer OpenClaw disse brugeredigerbare filer:

- `AGENTS.md` — driftsinstruktioner + “hukommelse”
- `SOUL.md` — persona, grænser, tone
- `TOOLS.md` — brugermaintainede værktøjsnoter (f.eks. `imsg`, `sag`, konventioner)
- `BOOTSTRAP.md` — engangsritual ved første kørsel (slettes efter gennemførelse)
- `IDENTITY.md` — agentnavn/stemning/emoji
- `USER.md` — brugerprofil + foretrukken tiltaleform

Ved første tur i en ny session injicerer OpenClaw indholdet af disse filer direkte i agentens kontekst.

Tomme filer springes over. Store filer trimmes og afkortes med en markør, så prompts forbliver slanke (læs filen for fuldt indhold).

Hvis en fil mangler, injicerer OpenClaw en enkelt “manglende fil”-markørlinje (og `openclaw setup` opretter en sikker standardskabelon).

`BOOTSTRAP.md` oprettes kun for et **helt nyt workspace** (ingen andre bootstrap-filer til stede). Hvis du sletter den efter at have gennemført ritualet, bør den ikke blive genskabt ved senere genstarter.

For helt at deaktivere oprettelse af bootstrap-filer (for forudseedede workspaces), sæt:

```json5
{ agent: { skipBootstrap: true } }
```

## Indbyggede værktøjer

Kerneværktøjer (read/exec/edit/write og relaterede systemværktøjer) er altid tilgængelige,
underlagt værktøjspolitik. `apply_patch` er valgfrit og styres af
`tools.exec.applyPatch`. `TOOLS.md` styrer **ikke**, hvilke værktøjer der findes; det er
vejledning til, hvordan _du_ ønsker, at de bruges.

## Skills

OpenClaw indlæser Skills fra tre placeringer (workspace vinder ved navnekonflikt):

- Bundlet (leveret med installationen)
- Administreret/lokal: `~/.openclaw/skills`
- Workspace: `<workspace>/skills`

Skills kan styres via config/env (se `skills` i [Gateway-konfiguration](/gateway/configuration)).

## pi-mono-integration

OpenClaw genbruger dele af pi-mono-kodebasen (modeller/værktøjer), men **sessionsstyring, discovery og værktøjsfortrådning ejes af OpenClaw**.

- Ingen pi-coding agent-runtime.
- Ingen `~/.pi/agent`- eller `<workspace>/.pi`-indstillinger konsulteres.

## Sessioner

Sessionsudskrifter gemmes som JSONL på:

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

Sessions-ID’et er stabilt og vælges af OpenClaw.
Ældre Pi/Tau-sessionsmapper læses **ikke**.

## Styring under streaming

Når queue-tilstand er `steer`, injiceres indgående beskeder i den aktuelle kørsel.
Køen tjekkes **efter hvert værktøjskald**; hvis der findes en køet besked,
springes resterende værktøjskald fra den aktuelle assistentbesked over (fejl-værktøjsresultater med “Skipped due to queued user message.”), hvorefter den køede brugerbesked injiceres før næste assistentsvar.

Når queue-tilstand er `followup` eller `collect`, holdes indgående beskeder tilbage, indtil
den aktuelle tur slutter, hvorefter en ny agenttur starter med de køede payloads. Se
[Queue](/concepts/queue) for tilstand + debounce-/kapacitetsadfærd.

Blokstreaming sender færdige assistentblokke, så snart de er afsluttet; det er
**slået fra som standard** (`agents.defaults.blockStreamingDefault: "off"`).
Justér grænsen via `agents.defaults.blockStreamingBreak` (`text_end` vs `message_end`; standard er text_end).
Styr blød blokopdeling med `agents.defaults.blockStreamingChunk` (standard
800–1200 tegn; foretrækker afsnitsbrud, derefter linjeskift; sætninger til sidst).
Saml streamede chunks med `agents.defaults.blockStreamingCoalesce` for at reducere
single-line-spam (idle-baseret sammensmeltning før afsendelse). Ikke-Telegram-kanaler kræver
eksplicit `*.blockStreaming: true` for at aktivere blok-svar.
Udførlige værktøjsresumeer udsendes ved værktøjsstart (ingen debounce); Control UI
streamer værktøjsoutput via agent-events, når det er tilgængeligt.
Flere detaljer: [Streaming + chunking](/concepts/streaming).

## Modelreferencer

Modelreferencer i config (for eksempel `agents.defaults.model` og `agents.defaults.models`) parses ved at splitte på den **første** `/`.

- Brug `provider/model` ved konfiguration af modeller.
- Hvis selve model-ID’et indeholder `/` (OpenRouter-stil), inkludér udbyderpræfikset (eksempel: `openrouter/moonshotai/kimi-k2`).
- Hvis du udelader udbyderen, behandler OpenClaw inputtet som et alias eller en model for **standardudbyderen** (virker kun, når der ikke er `/` i model-ID’et).

## Konfiguration (minimum)

Som minimum skal du sætte:

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (kraftigt anbefalet)

---

_Næste: [Group Chats](/channels/group-messages)_ 🦞
