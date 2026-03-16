# Per-Model Thinking Control

## Problem

Some third-party models (MiniMax M2.5, Moonshot Kimi K2.5) leak their internal thinking/reasoning process into the `text` content of responses. This is visible to end users and not desirable for production use.

## Solution

OpenClaw now supports per-model thinking control via `compat` configuration in `openclaw.json`:

### Option 1: `thinkingFormat: "disabled"`

Disable thinking tag parsing entirely for models that don't use structured thinking:

```json
{
  "models": {
    "minimax/m2.5": {
      "compat": {
        "thinkingFormat": "disabled"
      }
    }
  }
}
```

### Option 2: `disableThinking: true` (API-level suppression)

For models that support API-level thinking suppression (like Kimi):

```json
{
  "models": {
    "moonshot/kimi-k2.5": {
      "compat": {
        "disableThinking": true
      }
    }
  }
}
```

This sends `thinking: { type: "disabled" }` in the API request to suppress thinking at the source.

## Full Example

```json
{
  "models": {
    "providers": {
      "minimax": {
        "baseUrl": "https://api.minimax.chat/v1",
        "apiKey": "${MINIMAX_API_KEY}",
        "models": [
          {
            "id": "minimax/m2.5",
            "name": "MiniMax M2.5",
            "reasoning": true,
            "compat": {
              "thinkingFormat": "disabled"
            }
          }
        ]
      },
      "moonshot": {
        "baseUrl": "https://api.moonshot.cn/v1",
        "apiKey": "${MOONSHOT_API_KEY}",
        "models": [
          {
            "id": "moonshot/kimi-k2.5",
            "name": "Kimi K2.5",
            "reasoning": true,
            "compat": {
              "disableThinking": true
            }
          }
        ]
      }
    }
  }
}
```

## Implementation Details

- `thinkingFormat: "disabled"` - Strips all thinking tags, no special parsing
- `disableThinking: true` - Sends API parameter to prevent thinking generation at source (model-dependent)
