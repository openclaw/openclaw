---
title: Lobster
summary: "Typet workflow-runtime til OpenClaw med genoptagelige godkendelsesporte."
description: Typet workflow-runtime til OpenClaw — sammensættelige pipelines med godkendelsesporte.
read_when:
  - Du ønsker deterministiske flertrins-workflows med eksplicitte godkendelser
  - Du har brug for at genoptage et workflow uden at genkøre tidligere trin
x-i18n:
  source_path: tools/lobster.md
  source_hash: e787b65558569e8a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:55Z
---

# Lobster

Lobster er en workflow-shell, der lader OpenClaw køre flertrins værktøjssekvenser som én samlet, deterministisk operation med eksplicitte godkendelseskontrolpunkter.

## Hook

Din assistent kan bygge de værktøjer, der administrerer den selv. Bed om et workflow, og 30 minutter senere har du en CLI plus pipelines, der kører som ét kald. Lobster er den manglende brik: deterministiske pipelines, eksplicitte godkendelser og genoptagelig tilstand.

## Why

I dag kræver komplekse workflows mange frem-og-tilbage værktøjskald. Hvert kald koster tokens, og LLM’en skal orkestrere hvert trin. Lobster flytter den orkestrering ind i en typet runtime:

- **Ét kald i stedet for mange**: OpenClaw kører ét Lobster-værktøjskald og får et struktureret resultat.
- **Godkendelser indbygget**: Sideeffekter (send e-mail, post kommentar) stopper workflowet, indtil det eksplicit godkendes.
- **Genoptagelig**: Stoppede workflows returnerer et token; godkend og genoptag uden at genkøre det hele.

## Why a DSL instead of plain programs?

Lobster er bevidst lille. Målet er ikke “et nyt sprog”, men en forudsigelig, AI-venlig pipeline-specifikation med førsteklasses godkendelser og genoptagelsestokens.

- **Godkend/genoptag er indbygget**: Et almindeligt program kan spørge et menneske, men det kan ikke _pause og genoptage_ med et holdbart token uden at du selv opfinder den runtime.
- **Determinisme + sporbarhed**: Pipelines er data, så de er nemme at logge, diff’e, afspille igen og gennemse.
- **Begrænset overflade for AI**: En lille grammatik + JSON-piping reducerer “kreative” kodeveje og gør validering realistisk.
- **Sikkerhedspolitik indbygget**: Timeouts, outputlofter, sandbox-tjek og tilladelseslister håndhæves af runtimen, ikke af hvert script.
- **Stadig programmerbar**: Hvert trin kan kalde enhver CLI eller ethvert script. Hvis du vil bruge JS/TS, så generér `.lobster`-filer fra kode.

## How it works

OpenClaw starter den lokale `lobster` CLI i **tool mode** og parser en JSON-envelope fra stdout.
Hvis pipelinen pauser for godkendelse, returnerer værktøjet et `resumeToken`, så du kan fortsætte senere.

## Pattern: small CLI + JSON pipes + approvals

Byg små kommandoer, der taler JSON, og kæd dem derefter sammen i ét enkelt Lobster-kald. (Eksempelkommandoer nedenfor — udskift med dine egne.)

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

Hvis pipelinen anmoder om godkendelse, så genoptag med tokenet:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

AI udløser workflowet; Lobster eksekverer trinnene. Godkendelsesporte holder sideeffekter eksplicitte og sporbare.

Eksempel: map input-elementer til værktøjskald:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON-only LLM steps (llm-task)

For workflows, der har brug for et **struktureret LLM-trin**, kan du aktivere det valgfrie
`llm-task` plugin-værktøj og kalde det fra Lobster. Det holder workflowet
deterministisk, samtidig med at du kan klassificere/summarisere/udarbejde med en model.

Aktivér værktøjet:

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

Brug det i en pipeline:

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

Se [LLM Task](/tools/llm-task) for detaljer og konfigurationsmuligheder.

## Workflow-filer (.lobster)

Lobster kan køre YAML/JSON-workflowfiler med felterne `name`, `args`, `steps`, `env`, `condition` og `approval`. I OpenClaw-værktøjskald skal du sætte `pipeline` til filstien.

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

Noter:

- `stdin: $step.stdout` og `stdin: $step.json` videresender output fra et tidligere trin.
- `condition` (eller `when`) kan gate trin baseret på `$step.approved`.

## Install Lobster

Installér Lobster CLI på **samme vært**, der kører OpenClaw Gateway (se [Lobster-repoet](https://github.com/openclaw/lobster)), og sørg for, at `lobster` er på `PATH`.
Hvis du vil bruge en brugerdefineret binær placering, så angiv en **absolut** `lobsterPath` i værktøjskaldet.

## Enable the tool

Lobster er et **valgfrit** plugin-værktøj (ikke aktiveret som standard).

Anbefalet (additivt, sikkert):

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

Eller pr. agent:

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

Undgå at bruge `tools.allow: ["lobster"]`, medmindre du har til hensigt at køre i restriktiv tilladelsesliste-tilstand.

Note: tilladelseslister er opt-in for valgfrie plugins. Hvis din tilladelsesliste kun nævner
plugin-værktøjer (som `lobster`), holder OpenClaw kernetools aktiveret. For at begrænse kerneværktøjer
skal du også inkludere de kerneværktøjer eller -grupper, du ønsker, i tilladelseslisten.

## Example: Email triage

Uden Lobster:

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

Returnerer en JSON-envelope (afkortet):

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

Bruger godkender → genoptag:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

Ét workflow. Deterministisk. Sikkert.

## Tool parameters

### `run`

Kør en pipeline i tool mode.

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

Kør en workflow-fil med argumenter:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

Fortsæt et stoppet workflow efter godkendelse.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Optional inputs

- `lobsterPath`: Absolut sti til Lobster-binæren (udelad for at bruge `PATH`).
- `cwd`: Arbejdsmappe for pipelinen (standard er den aktuelle proces’ arbejdsmappe).
- `timeoutMs`: Dræb underprocessen, hvis den overstiger denne varighed (standard: 20000).
- `maxStdoutBytes`: Dræb underprocessen, hvis stdout overstiger denne størrelse (standard: 512000).
- `argsJson`: JSON-streng sendt til `lobster run --args-json` (kun workflow-filer).

## Output envelope

Lobster returnerer en JSON-envelope med én af tre statusser:

- `ok` → afsluttet med succes
- `needs_approval` → pauset; `requiresApproval.resumeToken` er påkrævet for at genoptage
- `cancelled` → eksplicit afvist eller annulleret

Værktøjet eksponerer envelopen både i `content` (pæn JSON) og `details` (råt objekt).

## Approvals

Hvis `requiresApproval` er til stede, så inspicér prompten og beslut:

- `approve: true` → genoptag og fortsæt sideeffekter
- `approve: false` → annullér og afslut workflowet

Brug `approve --preview-from-stdin --limit N` til at vedhæfte et JSON-preview til godkendelsesanmodninger uden brugerdefineret jq/heredoc-lim. Genoptagelsestokens er nu kompakte: Lobster gemmer workflowets genoptagelsestilstand under sin state-dir og returnerer en lille token-nøgle.

## OpenProse

OpenProse passer godt sammen med Lobster: brug `/prose` til at orkestrere forberedelse med flere agenter, og kør derefter en Lobster-pipeline for deterministiske godkendelser. Hvis et Prose-program har brug for Lobster, så tillad `lobster`-værktøjet for underagenter via `tools.subagents.tools`. Se [OpenProse](/prose).

## Safety

- **Kun lokale underprocesser** — ingen netværkskald fra selve plugin’et.
- **Ingen hemmeligheder** — Lobster håndterer ikke OAuth; det kalder OpenClaw-værktøjer, der gør.
- **Sandbox-aware** — deaktiveret, når værktøjskonteksten er sandboxed.
- **Hærdet** — `lobsterPath` skal være absolut, hvis angivet; timeouts og outputlofter håndhæves.

## Troubleshooting

- **`lobster subprocess timed out`** → øg `timeoutMs`, eller opdel en lang pipeline.
- **`lobster output exceeded maxStdoutBytes`** → hæv `maxStdoutBytes` eller reducer outputstørrelsen.
- **`lobster returned invalid JSON`** → sørg for, at pipelinen kører i tool mode og kun printer JSON.
- **`lobster failed (code …)`** → kør den samme pipeline i en terminal for at inspicere stderr.

## Learn more

- [Plugins](/tools/plugin)
- [Plugin tool authoring](/plugins/agent-tools)

## Case study: community workflows

Et offentligt eksempel: en “second brain” CLI + Lobster-pipelines, der administrerer tre Markdown-vaults (personlig, partner, delt). CLI’en udskriver JSON for statistik, indbakkeoversigter og forældede scanninger; Lobster kæder disse kommandoer sammen i workflows som `weekly-review`, `inbox-triage`, `memory-consolidation` og `shared-task-sync`, hver med godkendelsesporte. AI håndterer vurdering (kategorisering), når det er tilgængeligt, og falder tilbage til deterministiske regler, når det ikke er.

- Tråd: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
