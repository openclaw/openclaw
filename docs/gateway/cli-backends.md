---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "CLI backends: text-only fallback via local AI CLIs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want a reliable fallback when API providers fail（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You are running Claude Code CLI or other local AI CLIs and want to reuse them（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need a text-only, tool-free path that still supports sessions and images（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "CLI Backends"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# CLI backends (fallback runtime)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can run **local AI CLIs** as a **text-only fallback** when API providers are down,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
rate-limited, or temporarily misbehaving. This is intentionally conservative:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Tools are disabled** (no tool calls).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Text in → text out** (reliable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sessions are supported** (so follow-up turns stay coherent).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Images can be passed through** if the CLI accepts image paths.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is designed as a **safety net** rather than a primary path. Use it when you（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
want “always works” text responses without relying on external APIs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Beginner-friendly quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can use Claude Code CLI **without any config** (OpenClaw ships a built-in default):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --message "hi" --model claude-cli/opus-4.6（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Codex CLI also works out of the box:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If your gateway runs under launchd/systemd and PATH is minimal, add just the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
command path:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      cliBackends: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "claude-cli": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          command: "/opt/homebrew/bin/claude",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
That’s it. No keys, no extra auth config needed beyond the CLI itself.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Using it as a fallback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add a CLI backend to your fallback list so it only runs when primary models fail:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        primary: "anthropic/claude-opus-4-6",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      models: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "anthropic/claude-opus-4-6": { alias: "Opus" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "claude-cli/opus-4.6": {},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "claude-cli/opus-4.5": {},（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you use `agents.defaults.models` (allowlist), you must include `claude-cli/...`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the primary provider fails (auth, rate limits, timeouts), OpenClaw will（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  try the CLI backend next.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration overview（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All CLI backends live under:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agents.defaults.cliBackends（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each entry is keyed by a **provider id** (e.g. `claude-cli`, `my-cli`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The provider id becomes the left side of your model ref:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<provider>/<model>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Example configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      cliBackends: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "claude-cli": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          command: "/opt/homebrew/bin/claude",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "my-cli": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          command: "my-cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          args: ["--json"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          output: "json",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          input: "arg",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          modelArg: "--model",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          modelAliases: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "claude-opus-4-6": "opus",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "claude-opus-4-5": "opus",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            "claude-sonnet-4-5": "sonnet",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          sessionArg: "--session",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          sessionMode: "existing",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          sessionIdFields: ["session_id", "conversation_id"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          systemPromptArg: "--system",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          systemPromptWhen: "first",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          imageArg: "--image",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          imageMode: "repeat",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          serialize: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How it works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Selects a backend** based on the provider prefix (`claude-cli/...`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Builds a system prompt** using the same OpenClaw prompt + workspace context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Executes the CLI** with a session id (if supported) so history stays consistent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Parses output** (JSON or plain text) and returns the final text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Persists session ids** per backend, so follow-ups reuse the same CLI session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the CLI supports sessions, set `sessionArg` (e.g. `--session-id`) or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `sessionArgs` (placeholder `{sessionId}`) when the ID needs to be inserted（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  into multiple flags.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the CLI uses a **resume subcommand** with different flags, set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `resumeArgs` (replaces `args` when resuming) and optionally `resumeOutput`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (for non-JSON resumes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionMode`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `always`: always send a session id (new UUID if none stored).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `existing`: only send a session id if one was stored before.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `none`: never send a session id.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Images (pass-through)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If your CLI accepts image paths, set `imageArg`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
imageArg: "--image",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
imageMode: "repeat"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw will write base64 images to temp files. If `imageArg` is set, those（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
paths are passed as CLI args. If `imageArg` is missing, OpenClaw appends the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
file paths to the prompt (path injection), which is enough for CLIs that auto-（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
load local files from plain paths (Claude Code CLI behavior).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Inputs / outputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `output: "json"` (default) tries to parse JSON and extract text + session id.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `output: "jsonl"` parses JSONL streams (Codex CLI `--json`) and extracts the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  last agent message plus `thread_id` when present.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `output: "text"` treats stdout as the final response.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Input modes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `input: "arg"` (default) passes the prompt as the last CLI arg.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `input: "stdin"` sends the prompt via stdin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the prompt is very long and `maxPromptArgChars` is set, stdin is used.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Defaults (built-in)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw ships a default for `claude-cli`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `command: "claude"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `modelArg: "--model"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `systemPromptArg: "--append-system-prompt"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionArg: "--session-id"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `systemPromptWhen: "first"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionMode: "always"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw also ships a default for `codex-cli`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `command: "codex"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `output: "jsonl"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `resumeOutput: "text"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `modelArg: "--model"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `imageArg: "--image"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionMode: "existing"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Override only if needed (common: absolute `command` path).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Limitations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **No OpenClaw tools** (the CLI backend never receives tool calls). Some CLIs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  may still run their own agent tooling.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **No streaming** (CLI output is collected then returned).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Structured outputs** depend on the CLI’s JSON format.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Codex CLI sessions** resume via text output (no JSONL), which is less（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  structured than the initial `--json` run. OpenClaw sessions still work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  normally.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **CLI not found**: set `command` to a full path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Wrong model name**: use `modelAliases` to map `provider/model` → CLI model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **No session continuity**: ensure `sessionArg` is set and `sessionMode` is not（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `none` (Codex CLI currently cannot resume with JSON output).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Images ignored**: set `imageArg` (and verify CLI supports file paths).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
