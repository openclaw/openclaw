---
summary: "Mga CLI backend: text-only fallback sa pamamagitan ng lokal na AI CLIs"
read_when:
  - Gusto mo ng maaasahang fallback kapag pumapalya ang mga API provider
  - Nagpapatakbo ka ng Claude Code CLI o iba pang lokal na AI CLIs at gusto mo silang muling gamitin
  - Kailangan mo ng text-only, walang tool na ruta na patuloy na sumusuporta sa sessions at images
title: "Mga CLI Backend"
x-i18n:
  source_path: gateway/cli-backends.md
  source_hash: 8285f4829900bc81
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:37Z
---

# Mga CLI backend (fallback runtime)

Kayang patakbuhin ng OpenClaw ang **lokal na AI CLIs** bilang **text-only fallback** kapag down,
na-rate-limit, o pansamantalang may problema ang mga API provider. Ito ay sadyang konserbatibo:

- **Naka-disable ang mga tool** (walang tool calls).
- **Text in → text out** (maaasahan).
- **Sinusuportahan ang sessions** (para manatiling magkakaugnay ang mga follow-up turn).
- **Maaaring ipasa ang images** kung tumatanggap ang CLI ng mga image path.

Dinisenyo ito bilang **safety net** sa halip na pangunahing ruta. Gamitin ito kapag gusto mo ng
“palaging gumagana” na text responses nang hindi umaasa sa mga external API.

## Beginner-friendly na mabilis na pagsisimula

Maaari mong gamitin ang Claude Code CLI **nang walang kahit anong config** (may kasamang built-in default ang OpenClaw):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Gumagana rin agad ang Codex CLI:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

Kung tumatakbo ang iyong Gateway sa ilalim ng launchd/systemd at minimal ang PATH, idagdag lang ang
command path:

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

Iyon na. Walang keys, walang dagdag na auth config na kailangan bukod sa mismong CLI.

## Paggamit bilang fallback

Magdagdag ng CLI backend sa iyong fallback list para tumakbo lang ito kapag pumalya ang mga primary model:

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

Mga tala:

- Kung gumagamit ka ng `agents.defaults.models` (allowlist), dapat mong isama ang `claude-cli/...`.
- Kapag pumalya ang primary provider (auth, rate limits, timeouts), susubukan ng OpenClaw ang CLI backend kasunod.

## Pangkalahatang-ideya ng configuration

Lahat ng CLI backend ay nasa ilalim ng:

```
agents.defaults.cliBackends
```

Ang bawat entry ay naka-key sa isang **provider id** (hal. `claude-cli`, `my-cli`).
Ang provider id ang nagiging kaliwang bahagi ng iyong model ref:

```
<provider>/<model>
```

### Halimbawang configuration

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

## Paano ito gumagana

1. **Pumipili ng backend** batay sa provider prefix (`claude-cli/...`).
2. **Bumubuo ng system prompt** gamit ang parehong OpenClaw prompt + workspace context.
3. **Pinapatakbo ang CLI** na may session id (kung suportado) para manatiling pare-pareho ang history.
4. **Pinoproseso ang output** (JSON o plain text) at ibinabalik ang huling text.
5. **Iniimbak ang mga session id** kada backend, para magamit muli ng mga follow-up ang parehong CLI session.

## Sessions

- Kung sinusuportahan ng CLI ang sessions, itakda ang `sessionArg` (hal. `--session-id`) o
  `sessionArgs` (placeholder `{sessionId}`) kapag kailangang ipasok ang ID sa maraming flag.
- Kung gumagamit ang CLI ng **resume subcommand** na may ibang mga flag, itakda ang
  `resumeArgs` (pinapalitan ang `args` kapag nagre-resume) at opsyonal ang `resumeOutput`
  (para sa non-JSON resumes).
- `sessionMode`:
  - `always`: laging magpadala ng session id (bagong UUID kung walang nakaimbak).
  - `existing`: magpadala lang ng session id kung may naimbak dati.
  - `none`: huwag kailanman magpadala ng session id.

## Images (pass-through)

Kung tumatanggap ang iyong CLI ng mga image path, itakda ang `imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

Isusulat ng OpenClaw ang mga base64 image sa mga temp file. Kung nakatakda ang `imageArg`, ang mga
path na iyon ay ipapasa bilang mga CLI arg. Kung nawawala ang `imageArg`, idinadagdag ng OpenClaw ang
mga file path sa prompt (path injection), na sapat para sa mga CLI na awtomatikong
naglo-load ng mga lokal na file mula sa plain paths (ugali ng Claude Code CLI).

## Inputs / outputs

- Sinusubukan ng `output: "json"` (default) na i-parse ang JSON at kunin ang text + session id.
- Ang `output: "jsonl"` ay nagpa-parse ng JSONL streams (Codex CLI `--json`) at kinukuha ang
  huling agent message kasama ang `thread_id` kapag mayroon.
- Tinuturing ng `output: "text"` ang stdout bilang huling response.

Mga input mode:

- Ang `input: "arg"` (default) ay ipinapasa ang prompt bilang huling CLI arg.
- Ang `input: "stdin"` ay nagpapadala ng prompt sa pamamagitan ng stdin.
- Kung napakahaba ng prompt at nakatakda ang `maxPromptArgChars`, gagamitin ang stdin.

## Mga default (built-in)

May kasamang default ang OpenClaw para sa `claude-cli`:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

Mayroon ding default ang OpenClaw para sa `codex-cli`:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

I-override lamang kung kinakailangan (karaniwan: absolute na `command` path).

## Mga limitasyon

- **Walang OpenClaw tools** (hindi kailanman tumatanggap ng tool calls ang CLI backend). Maaaring
  patakbuhin pa rin ng ilang CLI ang sarili nilang agent tooling.
- **Walang streaming** (kinokolekta muna ang CLI output bago ibalik).
- **Structured outputs** ay nakadepende sa JSON format ng CLI.
- **Codex CLI sessions** ay nagre-resume sa pamamagitan ng text output (walang JSONL), na mas
  hindi structured kaysa sa paunang `--json` run. Normal pa ring gumagana ang OpenClaw sessions.

## Pag-troubleshoot

- **Hindi makita ang CLI**: itakda ang `command` sa isang buong path.
- **Maling pangalan ng model**: gamitin ang `modelAliases` para i-map ang `provider/model` → CLI model.
- **Walang continuity ng session**: tiyaking nakatakda ang `sessionArg` at ang `sessionMode` ay hindi
  `none` (sa kasalukuyan, hindi kayang mag-resume ng Codex CLI gamit ang JSON output).
- **Hindi pinapansin ang images**: itakda ang `imageArg` (at tiyaking sinusuportahan ng CLI ang mga file path).
