---
summary: "CLI-backends: tekst-only fallback via lokale AI-CLI’er"
read_when:
  - Du vil have en pålidelig fallback, når API-udbydere fejler
  - Du kører Claude Code CLI eller andre lokale AI-CLI’er og vil genbruge dem
  - Du har brug for en tekst-only, værktøjsfri sti, der stadig understøtter sessioner og billeder
title: "CLI-backends"
---

# CLI-backends (fallback-runtime)

OpenClaw kan køre **lokale AI CLI'er** som en **kun tekst-tilbagefald** når API-udbydere er nede,
hastighedsbegrænsede, eller midlertidigt misværes. Dette er bevidst konservativ:

- **Værktøjer er deaktiveret** (ingen tool-kald).
- **Tekst ind → tekst ud** (pålideligt).
- **Sessioner understøttes** (så opfølgende ture forbliver sammenhængende).
- **Billeder kan videresendes**, hvis CLI’en accepterer billedstier.

Dette er designet som et **sikkerhedsnet** i stedet for en primær sti. Brug det, når du
ønsker “altid virker” tekstsvar uden at stole på eksterne API'er.

## Begyndervenlig hurtig start

Du kan bruge Claude Code CLI **uden nogen konfiguration** (OpenClaw leveres med en indbygget standard):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI virker også direkte:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

Hvis din gateway kører under launchd/systemd, og PATH er minimal, så tilføj blot
kommandostien:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

Det er det. Ingen nøgler, ingen ekstra auth config nødvendig ud over CLI selv.

## Brug som fallback

Tilføj en CLI-backend til din fallback-liste, så den kun kører, når primære modeller fejler:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/opus-4.6": {},
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

Noter:

- Hvis du bruger `agents.defaults.models` (tilladelsesliste), skal du inkludere `claude-cli/...`.
- Hvis den primære udbyder fejler (auth, rate limits, timeouts), vil OpenClaw
  forsøge CLI-backenden som næste skridt.

## Konfigurationsoverblik

Alle CLI-backends ligger under:

```
agents.defaults.cliBackends
```

Hver post er nøglen af en **provider id** (f.eks. `claude-cli`, `my-cli`).
Leverandør-id bliver venstre side af din model ref:

```
<provider>/<model>
```

### Eksempelkonfiguration

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## Sådan virker det

1. **Vælger en backend** baseret på provider-præfikset (`claude-cli/...`).
2. **Opbygger en systemprompt** ved brug af den samme OpenClaw-prompt + workspace-kontekst.
3. **Eksekverer CLI’en** med et session-id (hvis understøttet), så historikken forbliver konsistent.
4. **Parser output** (JSON eller almindelig tekst) og returnerer den endelige tekst.
5. **Persistér session-id’er** pr. backend, så opfølgninger genbruger den samme CLI-session.

## Sessioner

- Hvis CLI understøtter sessioner, angiv `sessionArg` (f.eks. `--session-id`) eller
  `sessionArgs` (pladsholder `{sessionId}`) når ID'et skal indsættes
  i flere flag.
- Hvis CLI’en bruger en **resume-subkommando** med andre flags, så sæt
  `resumeArgs` (erstatter `args` ved genoptagelse) og eventuelt `resumeOutput`
  (for ikke-JSON genoptagelser).
- `sessionMode`:
  - `always`: send altid et session-id (nyt UUID, hvis intet er gemt).
  - `existing`: send kun et session-id, hvis der tidligere var gemt et.
  - `none`: send aldrig et session-id.

## Billeder (pass-through)

Hvis din CLI accepterer billedstier, så sæt `imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw vil skrive base64 billeder til temp filer. Hvis `imageArg` er indstillet, disse
stier bestået som CLI args. Hvis `imageArg` mangler, tilføjer OpenClaw
filstierne til prompten (stiindsprøjtning af stien), som er nok for CLIs at auto-
indlæse lokale filer fra almindelige stier (Claude Code CLI adfærd).

## Input / output

- `output: "json"` (standard) forsøger at parse JSON og udtrække tekst + session-id.
- `output: "jsonl"` parser JSONL-streams (Codex CLI `--json`) og udtrækker den
  sidste agentbesked samt `thread_id`, når den findes.
- `output: "text"` behandler stdout som det endelige svar.

Input-tilstande:

- `input: "arg"` (standard) sender prompten som det sidste CLI-argument.
- `input: "stdin"` sender prompten via stdin.
- Hvis prompten er meget lang, og `maxPromptArgChars` er sat, bruges stdin.

## Standarder (indbygget)

OpenClaw leveres med en standard for `claude-cli`:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw leveres også med en standard for `codex-cli`:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

Tilsidesæt kun, hvis det er nødvendigt (almindeligt: absolut `command`-sti).

## Begrænsninger

- **Ingen OpenClaw værktøjer** (CLI backend modtager aldrig værktøjs opkald). Nogle CLIs
  kan stadig køre deres egen agent værktøj.
- **Ingen streaming** (CLI-output samles og returneres derefter).
- **Strukturerede outputs** afhænger af CLI’ens JSON-format.
- **Codex CLI sessioner** genoptag via tekst output (ingen JSONL), som er mindre
  struktureret end den oprindelige `--json` run. OpenClaw sessions fungerer stadig
  normalt.

## Fejlfinding

- **CLI ikke fundet**: sæt `command` til en fuld sti.
- **Forkert modelnavn**: brug `modelAliases` til at mappe `provider/model` → CLI-model.
- **Ingen session-kontinuitet**: sørg for, at `sessionArg` er sat, og at `sessionMode` ikke er
  `none` (Codex CLI kan i øjeblikket ikke genoptage med JSON-output).
- **Billeder ignoreres**: sæt `imageArg` (og verificér, at CLI’en understøtter filstier).
