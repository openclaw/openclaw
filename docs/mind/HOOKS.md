# Model Hooks

Hooks execute shell scripts before or after each model turn. They are configured per model under `agents.defaults.models` in `openclaw.json` and run in **all paths** — Telegram/Discord, RPC, and embedded agent.

### Configuration

```json
{
  "agents": {
    "defaults": {
      "models": {
        "local/Qwen-3.5-27B": {
          "beforeMessage": {
            "command": "~/scripts/before-message.sh {sessionId}",
            "timeoutSeconds": 15
          },
          "afterResponse": {
            "command": "~/scripts/save-slot.sh {sessionId}",
            "timeoutSeconds": 15
          }
        }
      }
    }
  }
}
```

### Hooks

| Hook            | When                            | Blocks response            |
| --------------- | ------------------------------- | -------------------------- |
| `beforeMessage` | Before the model turn starts    | Yes (waits for completion) |
| `afterResponse` | After the response is delivered | No (fire-and-forget)       |

### Substitution variables

| Variable             | Value                            |
| -------------------- | -------------------------------- |
| `{sessionId}`        | Current session ID               |
| `{agentId}`          | Agent ID                         |
| `{provider}`         | Model provider (e.g. `local`)    |
| `{model}`            | Model name (e.g. `Qwen-3.5-27B`) |
| `{previousProvider}` | Provider before a model switch   |
| `{previousModel}`    | Model before a model switch      |

### Example: local model with Wake-on-LAN and KV cache

This is the setup used in Mindbot for the main 27B model running on a remote Windows PC:

```json
"local/Qwen-3.5-27B": {
  "beforeMessage": {
    "command": "~/scripts/before-message.sh {sessionId}",
    "timeoutSeconds": 15
  },
  "afterResponse": {
    "command": "~/scripts/save-slot.sh {sessionId}",
    "timeoutSeconds": 15
  }
}
```

- `before-message.sh {sessionId}`: sends WOL if PC is offline, waits for llama-server to be healthy, then restores the KV cache slot for the session (`POST /slots/0?action=restore` with `cache-session-<sessionId>.bin`).
- `save-slot.sh {sessionId}`: saves the KV cache slot to disk after the response (`POST /slots/0?action=save`).

This preserves context across gateway restarts and PC sleep/wake cycles without any changes to Mindbot core code.

### Example: inactivity timer reset

For other local models that don't need per-session KV cache:

```json
"local/Qwen-3.5-9B": {
  "beforeMessage": {
    "command": "~/scripts/on-message.sh",
    "timeoutSeconds": 10
  }
}
```

`on-message.sh` resets a 30-minute inactivity timer (after which the PC auto-suspends), sends WOL if needed, and starts model servers if not already running.

### Tips

- Keep `beforeMessage` scripts fast — they block the response. Use `timeoutSeconds` to set a hard limit.
- `afterResponse` is fire-and-forget. Errors are logged but don't affect the response.
- Use a lockfile or `pkill` to prevent accumulation if the hook can be called concurrently (e.g. from a polling loop).
