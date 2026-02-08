---
title: Lobster
summary: ”Typad arbetsflödeskörning för OpenClaw med återupptagbara godkännandespärrar.”
description: Typed workflow runtime for OpenClaw — composable pipelines with approval gates.
read_when:
  - Du vill ha deterministiska flerstegsarbetsflöden med explicita godkännanden
  - Du behöver återuppta ett arbetsflöde utan att köra om tidigare steg
x-i18n:
  source_path: tools/lobster.md
  source_hash: e787b65558569e8a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:19:00Z
---

# Lobster

Lobster är ett arbetsflödesskal som låter OpenClaw köra flerstegssekvenser av verktyg som en enda, deterministisk operation med explicita kontrollpunkter för godkännande.

## Hook

Din assistent kan bygga verktygen som hanterar sig själv. Be om ett arbetsflöde, och 30 minuter senare har du ett CLI plus pipelines som körs som ett enda anrop. Lobster är den saknade pusselbiten: deterministiska pipelines, explicita godkännanden och återupptagbart tillstånd.

## Why

I dag kräver komplexa arbetsflöden många fram-och-tillbaka-anrop till verktyg. Varje anrop kostar tokens, och LLM:en måste orkestrera varje steg. Lobster flyttar den orkestreringen till en typad körmiljö:

- **Ett anrop i stället för många**: OpenClaw kör ett Lobster-verktygsanrop och får ett strukturerat resultat.
- **Inbyggda godkännanden**: Biverkningar (skicka e-post, posta kommentar) stoppar arbetsflödet tills de uttryckligen godkänns.
- **Återupptagbart**: Stoppade arbetsflöden returnerar en token; godkänn och återuppta utan att köra om allt.

## Why a DSL instead of plain programs?

Lobster är avsiktligt litet. Målet är inte ”ett nytt språk”, utan en förutsägbar, AI-vänlig pipelinespecifikation med förstklassiga godkännanden och återupptagningstokens.

- **Godkänn/återuppta är inbyggt**: Ett vanligt program kan fråga en människa, men kan inte _pausa och återuppta_ med en varaktig token utan att du själv uppfinner den körmiljön.
- **Determinism + granskningsbarhet**: Pipelines är data, så de är enkla att logga, diffa, spela upp igen och granska.
- **Begränsad yta för AI**: En liten grammatik + JSON-piping minskar ”kreativa” kodvägar och gör validering realistisk.
- **Säkerhetspolicy inbakad**: Tidsgränser, utdata-tak, sandbox-kontroller och tillåtelselistor verkställs av körmiljön, inte av varje skript.
- **Fortfarande programmerbart**: Varje steg kan anropa valfritt CLI eller skript. Vill du ha JS/TS, generera `.lobster`-filer från kod.

## How it works

OpenClaw startar det lokala `lobster` CLI i **tool mode** och tolkar ett JSON-kuvert från stdout.
Om pipelinen pausar för godkännande returnerar verktyget en `resumeToken` så att du kan fortsätta senare.

## Pattern: small CLI + JSON pipes + approvals

Bygg små kommandon som talar JSON och kedja dem sedan till ett enda Lobster-anrop. (Exempel på kommandonamn nedan — byt mot dina egna.)

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

AI triggar arbetsflödet; Lobster exekverar stegen. Godkännandespärrar håller biverkningar explicita och granskningsbara.

Exempel: mappa indatobjekt till verktygsanrop:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON-only LLM steps (llm-task)

För arbetsflöden som behöver ett **strukturerat LLM-steg**, aktivera det valfria
`llm-task` plugin-verktyget och anropa det från Lobster. Detta håller arbetsflödet
deterministiskt samtidigt som du kan klassificera/sammanfatta/utkasta med en modell.

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

Lobster kan köra YAML/JSON-arbetsflödesfiler med fälten `name`, `args`, `steps`, `env`, `condition` och `approval`. I OpenClaw-verktygsanrop sätter du `pipeline` till filsökvägen.

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

Installera Lobster-CLI:t på **samma värd** som kör OpenClaw Gateway (se [Lobster-repot](https://github.com/openclaw/lobster)) och säkerställ att `lobster` finns på `PATH`.
Om du vill använda en anpassad binär plats, skicka en **absolut** `lobsterPath` i verktygsanropet.

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

Obs: tillåtelselistor är opt-in för valfria plugins. Om din tillåtelselista endast namnger
plugin-verktyg (som `lobster`), behåller OpenClaw kärnverktygen aktiverade. För att begränsa kärnverktyg,
inkludera även de kärnverktyg eller grupper du vill ha i tillåtelselistan.

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

Ett arbetsflöde. Deterministiskt. Säkert.

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

Använd `approve --preview-from-stdin --limit N` för att bifoga en JSON-förhandsvisning till godkännandeförfrågningar utan anpassad jq/heredoc-limning. Återupptagningstokens är nu kompakta: Lobster lagrar arbetsflödets återupptagningstillstånd under sin tillståndskatalog och returnerar en liten tokennyckel.

## OpenProse

OpenProse passar bra ihop med Lobster: använd `/prose` för att orkestrera förarbete med flera agenter och kör sedan en Lobster-pipeline för deterministiska godkännanden. Om ett Prose-program behöver Lobster, tillåt `lobster`-verktyget för underagenter via `tools.subagents.tools`. Se [OpenProse](/prose).

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

Ett offentligt exempel: ett ”second brain”-CLI + Lobster-pipelines som hanterar tre Markdown-valv (personligt, partner, delat). CLI:t emitterar JSON för statistik, inkorgslistor och inaktuella skanningar; Lobster kedjar dessa kommandon till arbetsflöden som `weekly-review`, `inbox-triage`, `memory-consolidation` och `shared-task-sync`, vart och ett med godkännandespärrar. AI hanterar omdömen (kategorisering) när den finns tillgänglig och faller tillbaka till deterministiska regler när den inte gör det.

- Tråd: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
