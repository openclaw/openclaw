---
name: smart-model-router
description: Advanced model routing and cost management. Allows switching LLM providers (Google, OpenAI, etc.) based on task type, usage limits, or cost preferences.
metadata:
  moltbot:
    emoji: "🚦"
    requires:
      config: ["extensions.smart-model-router"]
---

# Smart Model Router

Use the `smart_router` tool to optimize model selection, manage API key usage, and reduce costs.

## When to use

- **Task Optimization**: When the user assigns a task that requires a specific capability (e.g., "coding", "creative writing", "math") that the current model is weak at.
- **Cost Management**: When the user asks to switch to a cheaper model or check usage limits.
- **Rate Limit Handling**: If the current model returns rate limit errors, use `route` to switch to a fallback model.
- **Manual Control**: When the user explicitly asks to "switch model to X" or "reset limits".

## Capabilities

### 1. Check Status

Get the current model, daily usage counts, and configured limits.

```json
{
  "action": "status"
}
```

### 2. Route / Switch Model

Switch the active model. You can route by **Task Type** (recommended) or **Force** a specific model ID.

**By Task Type:**

- The model selected depends on your configuration in `moltbot.json` (`extensions.smart-model-router.rules`).
- Common task types: `coding`, `fast`, `creative`, `chinese`.
- **Note**: You MUST have a configured rule for the requested task type. If no rule is found, the routing will fail.

```json
{
  "action": "route",
  "taskType": "coding"
}
```

**Force Specific Model:**
You can switch to ANY valid model ID, even if not listed in the task types.

**Supports Auth Profiles:**
Bind a model to a specific API key profile using `@` syntax (e.g., `google/gemini-3-flash-preview@google:free`). Use this when the user asks to switch to a "free key", "paid key", or specific account.

```json
{
  "action": "route",
  "forceModel": "google/gemini-3-flash-preview@google:free"
}
```

**Allowed Models Configuration:**
You can configure enabled models per provider in the plugin settings.
Example configuration structure:

- **Provider**: `google`
- **Models**: `['gemini-1.5-pro', 'gemini-1.5-flash']`

When `allowedModels` or provider-specific models are configured, the router enforces a whitelist, preventing unauthorized model usage.

**Note:** Switching models requires a Gateway restart. The tool will update the configuration, but the restart must be triggered (usually automatically or by instruction).

### 3. Reset Limits

Reset the daily usage counters (useful for testing or manual overrides).

- `profileId`: (Optional) Specify which profile to reset.

```json
{
  "action": "reset_limit",
  "profileId": "google:free"
}
```

## Configuration

The router uses `~/.clawdbot/smart-router-state.json` to persist usage data.
API Keys are managed in the standard `moltbot.json` under `auth.profiles`.

### Custom Routing Rules (Optional)

Add rules to `moltbot.json` to override or extend task types:

```json
"extensions": {
  "smart-model-router": {
    "rules": [
      {
        "type": "task",
        "condition": "writing",
        "targetModel": "anthropic/claude-sonnet-4-5"
      }
    ]
  }
}
```

## Best Practices

- **Coding Tasks**: Always prefer `coding` task type for complex software engineering queries.
- **Simple Queries**: Use `fast` to save costs and reduce latency.
- **Fallbacks**: If a `route` action fails (e.g., model not configured), inform the user and suggest checking `moltbot models list`.
