# Claude Agent SDK Runtime

This fork adds support for running OpenClaw agents through the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) instead of the default pi-agent runtime.

When enabled, the agent spawns a Claude Code subprocess via the SDK's `query()` function. This gives you access to all built-in Claude Code tools (bash, file read/write/edit, glob, grep, etc.) and handles session persistence, compaction, and streaming natively.

## Enabling the Claude SDK Runtime

There are three ways to enable it, in order of precedence:

### Option 1: Environment Variable

```bash
export OPENCLAW_AGENT_RUNTIME=claude-sdk
```

### Option 2: Config File (`~/.openclaw/openclaw.json`)

Add the `runtime` field under `agents.defaults`:

```json
{
  "agents": {
    "defaults": {
      "runtime": "claude-sdk"
    }
  }
}
```

### Option 3: Flat Config Property

If your config uses the flat schema:

```json
{
  "agentRuntime": "claude-sdk"
}
```

## Authentication

The SDK subprocess needs an Anthropic credential. OpenClaw resolves this from your configured auth profile and passes it to the subprocess automatically.

- **API Key auth** (`mode: "api-key"`): Passed as `ANTHROPIC_API_KEY`
- **OAuth auth** (`mode: "oauth"`): Passed as `CLAUDE_CODE_OAUTH_TOKEN`

Make sure your auth profile mode in `~/.openclaw/openclaw.json` matches the credential type stored in `~/.openclaw/auth-profiles.json`. For example, if you authenticated via OAuth, your config should have:

```json
{
  "auth": {
    "anthropic": {
      "default": {
        "mode": "oauth"
      }
    }
  }
}
```

## Requirements

- `@anthropic-ai/claude-agent-sdk` must be installed (already included in this fork's dependencies)
- Claude Code CLI must be available in the system PATH (the SDK spawns it as a subprocess)
- A valid Anthropic API key or OAuth token

## Reverting to pi-agent

To switch back to the default pi-agent runtime, remove the `runtime` field from your config (or set it to `"pi-agent"`), or unset the environment variable. The default is always `pi-agent` for backward compatibility.
