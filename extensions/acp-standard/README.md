# @openclaw/acp-standard

OpenClaw ACP runtime backend for **any standard ACP agent** — Kiro, Copilot, Cline, and [19+ others](https://agentclientprotocol.com/get-started/registry).

## What it does

This plugin implements the `AcpRuntime` interface using standard [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) JSON-RPC 2.0 over stdio. It spawns any ACP-compatible agent binary and translates between OpenClaw's internal event model and the ACP wire protocol.

```
OpenClaw gateway
  └─ acp-standard plugin (this)
       └─ any ACP agent (kiro-cli acp, copilot --acp --stdio, etc.)
            └─ JSON-RPC 2.0 over stdio
```

## Quick start

```bash
openclaw plugins install @openclaw/acp-standard
openclaw config set plugins.entries.acp-standard.enabled true
```

Configure in `openclaw.json`:

```json5
{
  acp: {
    enabled: true,
    backend: "acp-standard",
  },
  plugins: {
    entries: {
      "acp-standard": {
        enabled: true,
        config: {
          command: "kiro-cli",
          args: ["acp"],
        },
      },
    },
  },
}
```

## Config options

| Key       | Type     | Default       | Description                 |
| --------- | -------- | ------------- | --------------------------- |
| `command` | string   | `"kiro-cli"`  | Agent binary command        |
| `args`    | string[] | `["acp"]`     | Arguments to start ACP mode |
| `cwd`     | string   | workspace dir | Working directory           |
| `env`     | object   | `{}`          | Extra environment variables |

## Protocol mapping

| OpenClaw AcpRuntime | Standard ACP JSON-RPC 2.0                  |
| ------------------- | ------------------------------------------ |
| `ensureSession()`   | `initialize` + `session/new`               |
| `runTurn()`         | `session/prompt` → stream `session/update` |
| `cancel()`          | `session/cancel`                           |
| `close()`           | SIGTERM agent process                      |
| `setMode()`         | `session/set_mode`                         |

## Related

- [openclaw/openclaw#28511](https://github.com/openclaw/openclaw/issues/28511) — Feature request
- [ACP Registry](https://agentclientprotocol.com/get-started/registry) — 19+ compatible agents
- [ACP Specification](https://agentclientprotocol.com/) — Protocol spec
