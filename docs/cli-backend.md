# CLI Backend Configuration (Claude Code)

OpenClaw can use Claude Code CLI as a backend for agent responses. This section documents the working configuration and common pitfalls.

## Working Configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "claude-cli/sonnet"
      },
      "cliBackends": {
        "claude-cli": {
          "command": "claude",
          "args": ["-p", "--output-format", "json"],
          "output": "json",
          "input": "arg",
          "modelArg": "--model",
          "sessionMode": "always",
          "sessionArg": "--session-id"
        }
      }
    }
  }
}
```

## Windows-Specific Setup

Claude Code CLI requires git-bash on Windows. **Critical**: Set the path via shell environment variable, not JSON config.

**Start the gateway with:**
```bash
CLAUDE_CODE_GIT_BASH_PATH='C:\Users\<username>\Documents\Git\bin\bash.exe' node openclaw.mjs gateway run --port 18789 --verbose
```

**Why not JSON config?** Backslashes in JSON (`\\`) get interpreted as escape sequences when passed through the config system. For example, `\b` becomes a backspace character, corrupting paths like `C:\Users\...\bin\bash.exe` into `C:Users...inash.exe`.

## Session Mode Configuration

**Purpose:** Controls how Claude CLI manages conversation memory across messages.

**Valid Options:**
- `"always"` - **Recommended**: Creates/uses persistent sessions for conversation memory. Bot remembers context between messages.
- `"existing"` - Only resumes existing sessions, doesn't create new ones
- `"none"` - No session management. Each message starts fresh with no memory of previous messages.

**sessionArg:** When using `"always"` or `"existing"`, set `"sessionArg": "--session-id"` to specify the CLI argument for passing session IDs.

**Why sessionMode matters for Telegram/messaging bots:**
- Without session mode (`"none"`), the bot forgets context between messages, requiring users to repeat information
- With `"always"`, the bot maintains conversation history, making interactions more natural
- The gateway automatically hot-reloads when you change sessionMode in the config

**Schema Reference:** Valid values defined in `src/config/zod-schema.core.ts:253`

## Common Issues and Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| Bot forgets context between messages | Session mode disabled | Set `"sessionMode": "always"` and `"sessionArg": "--session-id"` in config |
| `Unknown model: anthropic/claude-opus-4.5` | Model version uses dots instead of dashes | Change `4.5` to `4-5` (use dashes not dots) |
| `Claude Code was unable to find CLAUDE_CODE_GIT_BASH_PATH` | Path escaping issue or wrong path | Set via shell env var with single quotes and backslashes |
| `No conversation found with session ID` | CLI trying to resume non-existent session | Check sessionMode is `"always"` not `"existing"` |
| Response is raw JSON/gibberish | Wrong output format parsing | Use `"output": "json"` with `"--output-format", "json"` (not `stream-json`/`jsonl`) |
| `When using --print, --output-format=stream-json requires --verbose` | Missing flag | Add `--verbose` if using stream-json (but prefer json format) |

## Output Format Notes

- **Use `json` format** (single JSON object with `result` field) - parser extracts text correctly
- **Avoid `stream-json`/`jsonl`** - the JSONL parser expects `item.text` structure which doesn't match Claude CLI's format
- Parser code: `src/agents/cli-runner/helpers.ts` (`parseCliJson`, `parseCliJsonl`)

## Critical: Model Naming Convention

**IMPORTANT**: There are THREE naming layers -- don't confuse them:

| Layer | Example | Where Used |
|-------|---------|------------|
| **Marketing name** | "Opus 4.6" (dots) | Conversation, docs, Anthropic blog posts |
| **API model ID** | `claude-opus-4-6` (dashes) | What the API actually returns in responses |
| **OpenClaw catalog name** | `anthropic/claude-opus-4-5` (dashes) | `openclaw.json`, `src/config/defaults.ts` |
| **OpenClaw alias** | `opus` | Short form in config, maps to catalog name |

**Key rules:**
1. **Always dashes, never dots** in any model identifier (`4-5` not `4.5`, `4-6` not `4.6`)
2. The OpenClaw catalog name `anthropic/claude-opus-4-5` maps to the **latest** Opus -- currently API model `claude-opus-4-6`. The `-4-5` is the catalog family, not the exact version.
3. For CLI backend, use `claude-cli/opus` -- this passes `--model opus` to the CLI which resolves to the latest Opus.

| Wrong | Correct | Why |
|-------|---------|-----|
| `claude-opus-4.5` | `claude-opus-4-5` | Dots not allowed |
| `anthropic/claude-sonnet-4.5` | `anthropic/claude-sonnet-4-5` | Dots not allowed |
| `anthropic/claude-opus-4-6` | `anthropic/claude-opus-4-5` or `claude-cli/opus` | `4-6` not in OpenClaw catalog |
| `anthropic/claude-opus-4-20260205` | `anthropic/claude-opus-4-5` or `claude-cli/opus` | Date IDs not in catalog |

**Reference**: See `src/config/defaults.ts` for canonical catalog names:
```typescript
opus: "anthropic/claude-opus-4-5",   // resolves to latest Opus (currently claude-opus-4-6)
sonnet: "anthropic/claude-sonnet-4-5", // resolves to latest Sonnet
```

## Testing Best Practices

**Before configuring CLI backend**, test with direct Anthropic API first:

1. **Start with Anthropic API** to verify Telegram/channel setup:
   ```json
   {
     "agents": {
       "defaults": {
         "model": {
           "primary": "anthropic/claude-opus-4-5"
         }
       }
     }
   }
   ```

2. **Test bot connectivity** - send a message and verify response

3. **Then switch to CLI backend**:
   ```json
   {
     "agents": {
       "defaults": {
         "model": {
           "primary": "claude-cli/opus"
         },
         "cliBackends": {
           "claude-cli": {
             "command": "claude",
             "args": ["-p", "--output-format", "json"],
             "output": "json",
             "input": "arg",
             "modelArg": "--model",
             "sessionMode": "always",
             "sessionArg": "--session-id"
           }
         }
       }
     }
   }
   ```

4. **Windows**: Kill gateway and restart with `CLAUDE_CODE_GIT_BASH_PATH` env var:
   ```bash
   cmd.exe /c "set ANTHROPIC_API_KEY=your-key && set OPENCLAW_GATEWAY_TOKEN=local-dev-token && set CLAUDE_CODE_GIT_BASH_PATH=C:\Users\<username>\Documents\Git\bin\bash.exe && node openclaw.mjs gateway run --port 18789 --verbose"
   ```

This isolates issues: first verify channels work, then add CLI backend complexity.

## Debugging

Enable verbose CLI output logging:
```bash
OPENCLAW_CLAUDE_CLI_LOG_OUTPUT=1 node openclaw.mjs gateway run --verbose
```

Check logs at: `\tmp\openclaw\openclaw-<date>.log`
