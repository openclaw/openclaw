---
title: Lobster
summary: "”Typad arbetsflödeskörning för OpenClaw med återupptagbara godkännandespärrar.”"
description: Typed workflow runtime for OpenClaw — composable pipelines with approval gates.
read_when:
  - Du vill ha deterministiska flerstegsarbetsflöden med explicita godkännanden
  - Du behöver återuppta ett arbetsflöde utan att köra om tidigare steg
---

# Lobster

Lobster är ett arbetsflödesskal som låter OpenClaw köra flerstegssekvenser av verktyg som en enda, deterministisk operation med explicita kontrollpunkter för godkännande.

## Hook

Din assistent kan bygga de verktyg som klarar sig själv. Be om ett arbetsflöde och 30 minuter senare har du en CLI plus pipelines som löper som ett samtal. Hummer är den saknade biten: deterministiska rörledningar, uttryckliga godkännanden, och återupptagningsbara tillstånd.

## Why

Idag kräver komplexa arbetsflöden många bak-och-tillbaka verktygssamtal. Varje samtal kostar tokens, och LLM måste orkestrera varje steg. Hummer flyttar den orkestreringen till en nedskriven körtid:

- **Ett anrop i stället för många**: OpenClaw kör ett Lobster-verktygsanrop och får ett strukturerat resultat.
- **Inbyggda godkännanden**: Biverkningar (skicka e-post, posta kommentar) stoppar arbetsflödet tills de uttryckligen godkänns.
- **Återupptagbart**: Stoppade arbetsflöden returnerar en token; godkänn och återuppta utan att köra om allt.

## Why a DSL instead of plain programs?

Hummer är avsiktligt liten. Målet är inte "ett nytt språk", det är en förutsägbar, AI-vänlig pipeline spec med förstklassiga godkännanden och återuppta tokens.

- **Godkänn/återuppta är inbyggt**: Ett vanligt program kan fråga en människa, men kan inte _pausa och återuppta_ med en varaktig token utan att du själv uppfinner den körmiljön.
- **Determinism + granskningsbarhet**: Pipelines är data, så de är enkla att logga, diffa, spela upp igen och granska.
- **Begränsad yta för AI**: En liten grammatik + JSON-piping minskar ”kreativa” kodvägar och gör validering realistisk.
- **Säkerhetspolicy inbakad**: Tidsgränser, utdata-tak, sandbox-kontroller och tillåtelselistor verkställs av körmiljön, inte av varje skript.
- **Fortfarande programmerbar**: Varje steg kan ringa någon CLI eller skript. Om du vill ha JS/TS, generera `.lobster`-filer från kod.

## How it works

OpenClaw lanserar den lokala `lobster` CLI i **verktygsläge** och tolkar ett JSON-kuvert från stdout.
Om rörledningen pausar för godkännande, returnerar verktyget en `resumeToken` så att du kan fortsätta senare.

## Pattern: small CLI + JSON pipes + approvals

Bygg små kommandon som talar JSON, sedan kedja dem till ett enda hummersamtal. (Exempelkommandonamn nedan — byt på egen hand.)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

Om pipelinen begär godkännande, återuppta med token:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI utlöser arbetsflödet; Hummer utför stegen. Godkännande grindar hålla biverkningar explicita och granskningsbara.

Exempel: mappa indatobjekt till verktygsanrop:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON-only LLM steps (llm-task)

För arbetsflöden som behöver ett **strukturerat LLM-steg**, aktivera tilläggsverktyget
`llm-task` och anropa det från Hummer. Detta håller arbetsflödet
deterministiskt medan du fortfarande låter dig klassificera/sammanfatta/utkast med en modell.

Aktivera verktyget:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

Använd det i en pipeline:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

Se [LLM Task](/tools/llm-task) för detaljer och konfigurationsalternativ.

## Workflow files (.lobster)

Hummer kan köra YAML/JSON arbetsflödesfiler med `name`, `args`, `steps`, `env`, `condition` och `approval`-fält. I OpenClaw verktygssamtal, ange `pipeline` till filsökvägen.

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

Noteringar:

- `stdin: $step.stdout` och `stdin: $step.json` skickar vidare ett tidigare stegs utdata.
- `condition` (eller `when`) kan spärra steg baserat på `$step.approved`.

## Install Lobster

Installera hummern CLI på **samma värd** som kör OpenClaw Gateway (se [Hummerrepo](https://github.com/openclaw/lobster)), och se till att `hummer` är på `PATH`.
Om du vill använda en anpassad binär plats, skicka en **absolut** `lobsterPath` i verktygssamtalet.

## Enable the tool

Lobster är ett **valfritt** plugin-verktyg (inte aktiverat som standard).

Rekommenderat (additivt, säkert):

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

Eller per agent:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

Undvik att använda `tools.allow: ["lobster"]` om du inte avser att köra i restriktivt tillåtelseläge.

Notera: allowlists are opt-in for optional plugins. Om din tillåtna lista bara namnger
plugin verktyg (som `lobster`), håller OpenClaw grundläggande verktyg aktiverade. För att begränsa kärnan
verktyg, inkludera de grundläggande verktyg eller grupper du vill ha i listan också.

## Example: Email triage

Utan Lobster:

```
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

Med Lobster:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

Returnerar ett JSON-kuvert (trunkerat):

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

Användaren godkänner → återuppta:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

Ett arbetsflöde. Bestämmelse. Säkert.

## Tool parameters

### `run`

Kör en pipeline i tool mode.

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

Kör en arbetsflödesfil med argument:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

Fortsätt ett stoppat arbetsflöde efter godkännande.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Optional inputs

- `lobsterPath`: Absolut sökväg till Lobster-binären (utelämna för att använda `PATH`).
- `cwd`: Arbetskatalog för pipelinen (standard är den aktuella processens arbetskatalog).
- `timeoutMs`: Döda underprocessen om den överskrider denna varaktighet (standard: 20000).
- `maxStdoutBytes`: Döda underprocessen om stdout överskrider denna storlek (standard: 512000).
- `argsJson`: JSON-sträng som skickas till `lobster run --args-json` (endast arbetsflödesfiler).

## Output envelope

Lobster returnerar ett JSON-kuvert med ett av tre statusar:

- `ok` → slutförd utan fel
- `needs_approval` → pausad; `requiresApproval.resumeToken` krävs för att återuppta
- `cancelled` → uttryckligen nekad eller avbruten

Verktyget exponerar kuvertet både i `content` (pretty JSON) och `details` (rått objekt).

## Approvals

Om `requiresApproval` finns, granska prompten och besluta:

- `approve: true` → återuppta och fortsätt biverkningar
- `approve: false` → avbryt och finalisera arbetsflödet

Använd `approve --preview-from-stdin --limit N` för att bifoga en JSON-förhandsgranskning till godkännandeförfrågningar utan anpassat jq/heredoc-lim. Återuppta tokens är nu kompakt: Hummer lagrar arbetsflöde återuppta tillstånd under dess tillstånd dir och händer tillbaka en liten token nyckel.

## OpenProse

OpenProse par bra med Hummer: använd `/prose` för att orkestrera multi-agent prep, och kör sedan en hummerpipeline för deterministiska godkännanden. Om ett Prosprogram behöver Hummer, tillåt `hummer`-verktyget för underagenter via `tools.subagents.tools`. Se [OpenProse](/prose).

## Safety

- **Endast lokala underprocesser** — inga nätverksanrop från pluginet självt.
- **Inga hemligheter** — Lobster hanterar inte OAuth; det anropar OpenClaw-verktyg som gör det.
- **Sandbox-medveten** — inaktiverad när verktygskontexten är sandboxed.
- **Härdad** — `lobsterPath` måste vara absolut om den anges; tidsgränser och utdata-tak verkställs.

## Troubleshooting

- **`lobster subprocess timed out`** → öka `timeoutMs` eller dela upp en lång pipeline.
- **`lobster output exceeded maxStdoutBytes`** → höj `maxStdoutBytes` eller minska utdatastorleken.
- **`lobster returned invalid JSON`** → säkerställ att pipelinen körs i tool mode och endast skriver JSON.
- **`lobster failed (code …)`** → kör samma pipeline i en terminal för att inspektera stderr.

## Learn more

- [Plugins](/tools/plugin)
- [Plugin tool authoring](/plugins/agent-tools)

## Case study: community workflows

Ett offentligt exempel: en ”second brain” CLI + Hummerledningar som hanterar tre Markdown-valv (personlig, partner, delad). CLI avger JSON för statistik, inkorgslistor och gamla skanningar; Hummerkedjor dessa kommandon i arbetsflöden som `weekly-review`, `inbox-triage`, `memory-consolidation`, och `shared-task-sync`, var och en med godkännandeportar. AI hanterar dom (kategorisering) när den är tillgänglig och faller tillbaka till deterministiska regler när den inte är det.

- Tråd: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
