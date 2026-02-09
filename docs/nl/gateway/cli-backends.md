---
summary: "CLI-backends: tekst-only fallback via lokale AI-CLI’s"
read_when:
  - Je wilt een betrouwbare fallback wanneer API-providers falen
  - Je draait Claude Code CLI of andere lokale AI-CLI’s en wilt ze hergebruiken
  - Je hebt een tekst-only, tool-vrije route nodig die nog steeds sessies en afbeeldingen ondersteunt
title: "CLI-backends"
---

# CLI-backends (fallback-runtime)

OpenClaw kan **lokale AI-CLI’s** uitvoeren als een **tekst-only fallback** wanneer API-providers uitvallen,
rate-limited zijn of tijdelijk verkeerd functioneren. Dit is bewust conservatief:

- **Tools zijn uitgeschakeld** (geen tool-calls).
- **Tekst in → tekst uit** (betrouwbaar).
- **Sessies worden ondersteund** (zodat vervolgbeurten coherent blijven).
- **Afbeeldingen kunnen worden doorgegeven** als de CLI afbeeldingspaden accepteert.

Dit is ontworpen als een **vangnet** in plaats van een primaire route. Gebruik het wanneer je
“werkt altijd” tekstreacties wilt zonder afhankelijk te zijn van externe API’s.

## Beginner-vriendelijke snelle start

Je kunt Claude Code CLI **zonder enige configuratie** gebruiken (OpenClaw levert een ingebouwde standaard):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI werkt ook direct:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

Als je Gateway draait onder launchd/systemd en PATH minimaal is, voeg dan alleen het
command-pad toe:

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

Dat is alles. Geen sleutels, geen extra auth-config nodig buiten de CLI zelf.

## Gebruik als fallback

Voeg een CLI-backend toe aan je fallbacklijst zodat deze alleen draait wanneer primaire modellen falen:

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

Notities:

- Als je `agents.defaults.models` (allowlist) gebruikt, moet je `claude-cli/...` opnemen.
- Als de primaire provider faalt (authenticatie, rate limits, time-outs), zal OpenClaw
  vervolgens de CLI-backend proberen.

## Configuratie-overzicht

Alle CLI-backends staan onder:

```
agents.defaults.cliBackends
```

Elke entry wordt gesleuteld door een **provider-id** (bijv. `claude-cli`, `my-cli`).
De provider-id wordt de linkerkant van je modelref:

```
<provider>/<model>
```

### Voorbeeldconfiguratie

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

## Hoe het werkt

1. **Selecteert een backend** op basis van de provider-prefix (`claude-cli/...`).
2. **Bouwt een systeemprompt** met dezelfde OpenClaw-prompt + werkruimtecontext.
3. **Voert de CLI uit** met een sessie-id (indien ondersteund) zodat de geschiedenis consistent blijft.
4. **Parseert de uitvoer** (JSON of platte tekst) en retourneert de uiteindelijke tekst.
5. **Bewaar sessie-id’s** per backend, zodat vervolgaanvragen dezelfde CLI-sessie hergebruiken.

## Sessies

- Als de CLI sessies ondersteunt, stel `sessionArg` in (bijv. `--session-id`) of
  `sessionArgs` (placeholder `{sessionId}`) wanneer de ID in meerdere flags moet worden ingevoegd.
- Als de CLI een **resume-subcommand** gebruikt met andere flags, stel
  `resumeArgs` in (vervangt `args` bij hervatten) en optioneel `resumeOutput`
  (voor niet-JSON hervattingen).
- `sessionMode`:
  - `always`: stuur altijd een sessie-id (nieuwe UUID als er geen is opgeslagen).
  - `existing`: stuur alleen een sessie-id als er eerder één was opgeslagen.
  - `none`: stuur nooit een sessie-id.

## Afbeeldingen (pass-through)

Als je CLI afbeeldingspaden accepteert, stel `imageArg` in:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw schrijft base64-afbeeldingen naar tijdelijke bestanden. Als `imageArg` is ingesteld, worden die
paden als CLI-argumenten doorgegeven. Als `imageArg` ontbreekt, voegt OpenClaw de
bestandspaden toe aan de prompt (padinjectie), wat voldoende is voor CLI’s die lokale bestanden
automatisch laden vanaf platte paden (gedrag van Claude Code CLI).

## Invoer / uitvoer

- `output: "json"` (standaard) probeert JSON te parsen en tekst + sessie-id te extraheren.
- `output: "jsonl"` parseert JSONL-streams (Codex CLI `--json`) en extraheert het
  laatste agent-bericht plus `thread_id` wanneer aanwezig.
- `output: "text"` behandelt stdout als de uiteindelijke respons.

Input modes:

- `input: "arg"` (standaard) geeft de prompt door als het laatste CLI-argument.
- `input: "stdin"` verstuurt de prompt via stdin.
- Als de prompt erg lang is en `maxPromptArgChars` is ingesteld, wordt stdin gebruikt.

## Standaardwaarden (ingebouwd)

OpenClaw levert een standaard voor `claude-cli`:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw levert ook een standaard voor `codex-cli`:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

Overschrijf alleen indien nodig (gebruikelijk: absoluut `command`-pad).

## Beperkingen

- **Geen OpenClaw-tools** (de CLI-backend ontvangt nooit tool-calls). Sommige CLI’s
  kunnen nog steeds hun eigen agent-tooling uitvoeren.
- **Geen streaming** (CLI-uitvoer wordt verzameld en daarna geretourneerd).
- **Gestructureerde uitvoer** is afhankelijk van het JSON-formaat van de CLI.
- **Codex CLI-sessies** worden hervat via tekstuitvoer (geen JSONL), wat minder
  gestructureerd is dan de initiële `--json`-run. OpenClaw-sessies blijven normaal werken.

## Problemen oplossen

- **CLI niet gevonden**: stel `command` in op een volledig pad.
- **Verkeerde modelnaam**: gebruik `modelAliases` om `provider/model` → CLI-model te mappen.
- **Geen sessiecontinuïteit**: zorg dat `sessionArg` is ingesteld en `sessionMode` niet
  `none` is (Codex CLI kan momenteel niet hervatten met JSON-uitvoer).
- **Afbeeldingen genegeerd**: stel `imageArg` in (en verifieer dat de CLI bestandspaden ondersteunt).
