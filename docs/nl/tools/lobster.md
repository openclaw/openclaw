---
title: Lobster
summary: "Getypte workflowruntime voor OpenClaw met hervatbare goedkeuringspoorten."
description: Getypte workflowruntime voor OpenClaw — composeerbare pijplijnen met goedkeuringspoorten.
read_when:
  - Je wilt deterministische meerstapsworkflows met expliciete goedkeuringen
  - Je moet een workflow kunnen hervatten zonder eerdere stappen opnieuw uit te voeren
---

# Lobster

Lobster is een workflow-shell waarmee OpenClaw meerstaps toolsequenties kan uitvoeren als één enkele, deterministische operatie met expliciete goedkeuringscheckpoints.

## Hook

Je assistent kan de tools bouwen die zichzelf beheren. Vraag om een workflow, en 30 minuten later heb je een CLI plus pijplijnen die als één aanroep draaien. Lobster is het ontbrekende stuk: deterministische pijplijnen, expliciete goedkeuringen en hervatbare status.

## Waarom

Vandaag vereisen complexe workflows veel heen-en-weer toolaanroepen. Elke aanroep kost tokens en het LLM moet elke stap orkestreren. Lobster verplaatst die orkestratie naar een getypte runtime:

- **Eén aanroep in plaats van veel**: OpenClaw voert één Lobster-toolaanroep uit en krijgt een gestructureerd resultaat.
- **Goedkeuringen ingebouwd**: Neveneffecten (e-mail verzenden, reactie plaatsen) stoppen de workflow totdat expliciet is goedgekeurd.
- **Hervatbaar**: Gestopte workflows geven een token terug; keur goed en hervat zonder alles opnieuw uit te voeren.

## Waarom een DSL in plaats van gewone programma’s?

Lobster is bewust klein. Het doel is niet “een nieuwe taal”, maar een voorspelbare, AI-vriendelijke pijplijnspecificatie met eersteklas goedkeuringen en hervattokens.

- **Goedkeuren/hervatten is ingebouwd**: Een normaal programma kan een mens vragen, maar kan niet _pauzeren en hervatten_ met een duurzaam token zonder dat je die runtime zelf bouwt.
- **Determinisme + auditbaarheid**: Pijplijnen zijn data, dus ze zijn eenvoudig te loggen, te diffen, te herhalen en te reviewen.
- **Beperkt oppervlak voor AI**: Een kleine grammatica + JSON-piping vermindert “creatieve” codepaden en maakt validatie realistisch.
- **Veiligheidsbeleid ingebakken**: Time-outs, uitvoerlimieten, sandbox-controles en toegestane lijsten worden door de runtime afgedwongen, niet door elk script.
- **Nog steeds programmeerbaar**: Elke stap kan elke CLI of script aanroepen. Wil je JS/TS, genereer `.lobster`-bestanden vanuit code.

## Hoe het werkt

OpenClaw start de lokale `lobster` CLI in **toolmodus** en parseert een JSON-envelop van stdout.
Als de pijplijn pauzeert voor goedkeuring, retourneert de tool een `resumeToken` zodat je later kunt doorgaan.

## Patroon: kleine CLI + JSON-pipes + goedkeuringen

Bouw kleine commando’s die JSON spreken en koppel ze vervolgens tot één Lobster-aanroep. (Voorbeeldcommando’s hieronder — vervang ze door je eigen.)

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

Als de pijplijn om goedkeuring vraagt, hervat met het token:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI triggert de workflow; Lobster voert de stappen uit. Goedkeuringspoorten houden neveneffecten expliciet en auditbaar.

Voorbeeld: invoeritems mappen naar toolaanroepen:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## Alleen-JSON LLM-stappen (llm-task)

Voor workflows die een **gestructureerde LLM-stap** nodig hebben, schakel de optionele
`llm-task` plugin-tool in en roep deze aan vanuit Lobster. Dit houdt de workflow
deterministisch terwijl je toch kunt classificeren/samenvatten/opstellen met een model.

Schakel de tool in:

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

Gebruik deze in een pijplijn:

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

Zie [LLM Task](/tools/llm-task) voor details en configuratieopties.

## Workflowbestanden (.lobster)

Lobster kan YAML/JSON-workflowbestanden uitvoeren met `name`, `args`, `steps`, `env`, `condition` en `approval`-velden. In OpenClaw-toolaanroepen stel je `pipeline` in op het bestandspad.

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

Notities:

- `stdin: $step.stdout` en `stdin: $step.json` geven de uitvoer van een eerdere stap door.
- `condition` (of `when`) kan stappen afschermen op basis van `$step.approved`.

## Lobster installeren

Installeer de Lobster CLI op **dezelfde host** die de OpenClaw Gateway draait (zie de [Lobster-repo](https://github.com/openclaw/lobster)) en zorg dat `lobster` op `PATH` staat.
Als je een aangepaste binaire locatie wilt gebruiken, geef een **absoluut** `lobsterPath` mee in de toolaanroep.

## De tool inschakelen

Lobster is een **optionele** plugin-tool (standaard niet ingeschakeld).

Aanbevolen (additief, veilig):

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

Of per agent:

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

Vermijd het gebruik van `tools.allow: ["lobster"]` tenzij je van plan bent in een restrictieve toegestane-lijstmodus te draaien.

Let op: toegestane lijsten zijn opt-in voor optionele plugins. Als je toegestane lijst alleen
plugin-tools noemt (zoals `lobster`), houdt OpenClaw kerntools ingeschakeld. Om kerntools te beperken,
moet je ook de kerntools of -groepen die je wilt opnemen in de toegestane lijst.

## Voorbeeld: e-mailtriage

Zonder Lobster:

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

Met Lobster:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

Retourneert een JSON-envelop (ingekort):

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

Gebruiker keurt goed → hervatten:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

Eén workflow. Deterministisch. Veilig.

## Toolparameters

### `run`

Voer een pijplijn uit in toolmodus.

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

Voer een workflowbestand uit met argumenten:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

Ga verder met een gestopte workflow na goedkeuring.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Optionele invoer

- `lobsterPath`: Absoluut pad naar de Lobster-binary (laat weg om `PATH` te gebruiken).
- `cwd`: Werkdirectory voor de pijplijn (standaard de huidige proces-werkdirectory).
- `timeoutMs`: Beëindig het subprocess als het deze duur overschrijdt (standaard: 20000).
- `maxStdoutBytes`: Beëindig het subprocess als stdout deze grootte overschrijdt (standaard: 512000).
- `argsJson`: JSON-string doorgegeven aan `lobster run --args-json` (alleen workflowbestanden).

## Uitvoerenvelop

Lobster retourneert een JSON-envelop met een van drie statussen:

- `ok` → succesvol voltooid
- `needs_approval` → gepauzeerd; `requiresApproval.resumeToken` is vereist om te hervatten
- `cancelled` → expliciet geweigerd of geannuleerd

De tool toont de envelop in zowel `content` (mooie JSON) als `details` (ruw object).

## Goedkeuringen

Als `requiresApproval` aanwezig is, inspecteer de prompt en beslis:

- `approve: true` → hervatten en doorgaan met neveneffecten
- `approve: false` → annuleren en de workflow afronden

Gebruik `approve --preview-from-stdin --limit N` om een JSON-voorbeeld aan goedkeuringsverzoeken toe te voegen zonder aangepaste jq/heredoc-plakwerk. Hervattokens zijn nu compact: Lobster slaat de hervatstatus van workflows op onder zijn statusdirectory en geeft een kleine tokensleutel terug.

## OpenProse

OpenProse werkt goed samen met Lobster: gebruik `/prose` om multi-agentvoorbereiding te orkestreren en voer vervolgens een Lobster-pijplijn uit voor deterministische goedkeuringen. Als een Prose-programma Lobster nodig heeft, sta de `lobster`-tool toe voor sub-agents via `tools.subagents.tools`. Zie [OpenProse](/prose).

## Veiligheid

- **Alleen lokale subprocessen** — geen netwerkoproepen vanuit de plugin zelf.
- **Geen geheimen** — Lobster beheert geen OAuth; het roept OpenClaw-tools aan die dat wel doen.
- **Sandbox-bewust** — uitgeschakeld wanneer de toolcontext gesandboxed is.
- **Gehard** — `lobsterPath` moet absoluut zijn indien opgegeven; time-outs en uitvoerlimieten worden afgedwongen.

## Problemen oplossen

- **`lobster subprocess timed out`** → verhoog `timeoutMs` of splits een lange pijplijn.
- **`lobster output exceeded maxStdoutBytes`** → verhoog `maxStdoutBytes` of verklein de uitvoergrootte.
- **`lobster returned invalid JSON`** → zorg dat de pijplijn in toolmodus draait en alleen JSON print.
- **`lobster failed (code …)`** → voer dezelfde pijplijn in een terminal uit om stderr te inspecteren.

## Meer informatie

- [Plugins](/tools/plugin)
- [Plugin-tool schrijven](/plugins/agent-tools)

## Casestudy: community-workflows

Een openbaar voorbeeld: een “second brain” CLI + Lobster-pijplijnen die drie Markdown-kluizen beheren (persoonlijk, partner, gedeeld). De CLI genereert JSON voor statistieken, inboxlijsten en scans op veroudering; Lobster koppelt die commando’s tot workflows zoals `weekly-review`, `inbox-triage`, `memory-consolidation` en `shared-task-sync`, elk met goedkeuringspoorten. AI verzorgt het oordeel (categorisatie) wanneer beschikbaar en valt terug op deterministische regels wanneer dat niet zo is.

- Thread: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
