---
summary: "CLI-backends: textbaserad reservlösning via lokala AI-CLI:er"
read_when:
  - Du vill ha en pålitlig reservlösning när API-leverantörer fallerar
  - Du kör Claude Code CLI eller andra lokala AI-CLI:er och vill återanvända dem
  - Du behöver en textbaserad, verktygsfri väg som ändå stöder sessioner och bilder
title: "CLI-backends"
x-i18n:
  source_path: gateway/cli-backends.md
  source_hash: 8285f4829900bc81
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:19Z
---

# CLI-backends (reservruntime)

OpenClaw kan köra **lokala AI-CLI:er** som en **textbaserad reservlösning** när API-leverantörer är nere,
rate-begränsade eller tillfälligt beter sig felaktigt. Detta är avsiktligt konservativt:

- **Verktyg är inaktiverade** (inga verktygsanrop).
- **Text in → text ut** (pålitligt).
- **Sessioner stöds** (så att uppföljande turer förblir sammanhängande).
- **Bilder kan skickas vidare** om CLI:t accepterar bildsökvägar.

Detta är utformat som ett **säkerhetsnät** snarare än en primär väg. Använd det när du
vill ha textbaserade svar som ”alltid fungerar” utan att förlita dig på externa API:er.

## Nybörjarvänlig snabbstart

Du kan använda Claude Code CLI **utan någon konfig** (OpenClaw levereras med ett inbyggt standardval):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI fungerar också direkt:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

Om din gateway körs under launchd/systemd och PATH är minimal, lägg bara till
kommandosökvägen:

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

Det är allt. Inga nycklar, ingen extra autentiseringskonfig utöver själva CLI:t.

## Använda det som reserv

Lägg till en CLI-backend i din reservlista så att den bara körs när primära modeller fallerar:

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

Noteringar:

- Om du använder `agents.defaults.models` (tillåtelselista) måste du inkludera `claude-cli/...`.
- Om den primära leverantören fallerar (autentisering, rate limits, timeouts) kommer OpenClaw
  att prova CLI-backenden härnäst.

## Översikt över konfiguration

Alla CLI-backends finns under:

```
agents.defaults.cliBackends
```

Varje post nycklas av ett **leverantörs-id** (t.ex. `claude-cli`, `my-cli`).
Leverantörs-id:t blir vänstersidan av din modellreferens:

```
<provider>/<model>
```

### Exempelkonfiguration

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

## Hur det fungerar

1. **Väljer en backend** baserat på leverantörsprefixet (`claude-cli/...`).
2. **Bygger en systemprompt** med samma OpenClaw-prompt + arbetsytekontext.
3. **Kör CLI:t** med ett sessions-id (om det stöds) så att historiken förblir konsekvent.
4. **Tolkar utdata** (JSON eller ren text) och returnerar den slutliga texten.
5. **Består sessions-id:n** per backend, så att uppföljningar återanvänder samma CLI-session.

## Sessioner

- Om CLI:t stöder sessioner, sätt `sessionArg` (t.ex. `--session-id`) eller
  `sessionArgs` (platshållare `{sessionId}`) när ID:t behöver infogas i flera flaggor.
- Om CLI:t använder ett **resume-underkommando** med andra flaggor, sätt
  `resumeArgs` (ersätter `args` vid återupptagning) och valfritt `resumeOutput`
  (för icke-JSON-återupptagningar).
- `sessionMode`:
  - `always`: skicka alltid ett sessions-id (ny UUID om ingen är lagrad).
  - `existing`: skicka bara ett sessions-id om ett tidigare har lagrats.
  - `none`: skicka aldrig ett sessions-id.

## Bilder (vidarebefordran)

Om ditt CLI accepterar bildsökvägar, sätt `imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw skriver base64-bilder till temporära filer. Om `imageArg` är satt,
skickas dessa sökvägar som CLI-argument. Om `imageArg` saknas, lägger OpenClaw till
filsökvägarna i prompten (sökvägsinjektion), vilket räcker för CLI:er som automatiskt
läser in lokala filer från rena sökvägar (Claude Code CLI-beteende).

## In- / utdata

- `output: "json"` (standard) försöker tolka JSON och extrahera text + sessions-id.
- `output: "jsonl"` tolkar JSONL-strömmar (Codex CLI `--json`) och extraherar det
  sista agentmeddelandet plus `thread_id` när det finns.
- `output: "text"` behandlar stdout som det slutliga svaret.

Indatalägen:

- `input: "arg"` (standard) skickar prompten som sista CLI-argument.
- `input: "stdin"` skickar prompten via stdin.
- Om prompten är mycket lång och `maxPromptArgChars` är satt används stdin.

## Standardvärden (inbyggda)

OpenClaw levereras med ett standardval för `claude-cli`:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw levereras också med ett standardval för `codex-cli`:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

Åsidosätt endast vid behov (vanligt: absolut `command`-sökväg).

## Begränsningar

- **Inga OpenClaw-verktyg** (CLI-backenden tar aldrig emot verktygsanrop). Vissa CLI:er
  kan ändå köra sina egna agentverktyg.
- **Ingen streaming** (CLI-utdata samlas in och returneras sedan).
- **Strukturerade utdata** beror på CLI:ts JSON-format.
- **Codex CLI-sessioner** återupptas via textutdata (ingen JSONL), vilket är mindre
  strukturerat än den initiala `--json`-körningen. OpenClaw-sessioner fungerar
  fortfarande normalt.

## Felsökning

- **CLI hittas inte**: sätt `command` till en fullständig sökväg.
- **Fel modellnamn**: använd `modelAliases` för att mappa `provider/model` → CLI-modell.
- **Ingen sessionskontinuitet**: säkerställ att `sessionArg` är satt och att `sessionMode` inte är
  `none` (Codex CLI kan för närvarande inte återuppta med JSON-utdata).
- **Bilder ignoreras**: sätt `imageArg` (och verifiera att CLI:t stöder filsökvägar).
