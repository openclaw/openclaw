# Response footer templates

`messages.responsePrefix` already gives OpenClaw a native way to prepend a lightweight header to outbound replies. This companion setting adds a native footer block after the main reply body and now integrates directly with the built-in `/usage` footer path.

## Config

```json
{
  "agents": {
    "defaults": {
      "responseUsage": "full"
    },
    "list": [{ "id": "main", "identity": { "name": "Jarvis" } }]
  },
  "messages": {
    "responsePrefix": "*{identityName}:*\n\n",
    "responseFooter": "↑{input} ↓{output} R{total} {contextPercent}% ctx {model} · {cost}\n— {identityName}"
  }
}
```

The footer is appended with exactly one blank line before it.

## Supported variables

`messages.responseFooter` and `messages.responsePrefix` share the same case-insensitive template resolver.

- `{model}` / `{modelFull}` / `{provider}`
- `{thinkingLevel}` / `{think}` / `{effort}`
- `{identity.name}` / `{identityName}`
- `{input}` / `{inputTokens}`
- `{output}` / `{outputTokens}`
- `{total}` / `{totalTokens}`
- `{cacheRead}` / `{cacheReadTokens}`
- `{cacheWrite}` / `{cacheWriteTokens}`
- `{context}` / `{contextUsed}` / `{contextUsedTokens}`
- `{contextMax}` / `{contextMaxTokens}` / `{contextWindow}`
- `{contextPercent}`
- `{cost}` / `{estimatedCost}` / `{estimatedCostUsd}`
- `{usage}` / `{usageLine}`
- `{session}` / `{sessionKey}`

Unresolved placeholders remain literal text in footers. For response prefixes, late-bound usage/context/cost placeholders are blanked until values are available so streamed replies do not expose raw template tokens.

## `/usage` integration

OpenClaw now supports two coordinated ways to surface response usage:

- session-level or inherited `/usage` modes (`off`, `tokens`, `full`)
- `messages.responseFooter` template output

`agents.defaults.responseUsage` provides the global inherited default for sessions that do not set `responseUsage` explicitly.

### Composition rules

- If the configured footer is static and `/usage` is enabled, OpenClaw folds the built-in usage line and the footer into one appended block.
- If the configured footer already references usage-style placeholders such as `{input}`, `{contextPercent}`, `{usage}`, or `{usageLine}`, OpenClaw suppresses the separate built-in usage line to avoid duplicate footer lines. Cost-only footers still compose with the built-in usage line unless you explicitly include `{usage}` or `{usageLine}` in the template.
- A session can still explicitly set `responseUsage: "off"` to suppress an inherited default from `agents.defaults.responseUsage`.

## Notes

- Footer rendering uses the fresh post-persist session snapshot when available, and otherwise falls back to the current prompt-context snapshot for context placeholders.
- `responsePrefix` can now receive the same late-bound usage/context/cost values. When a streamed block is sent before those values are known, OpenClaw blanks the unresolved late-bound prefix placeholders instead of emitting raw `{cost}`-style tokens.
- In successful block-streaming flows, the footer can still be delivered as a trailing payload even when the final body payload is intentionally suppressed.
- This implementation targets the normal reply pipeline. It does not change message-tool outbound sends or other non-reply delivery paths.

## Examples

A naming-agnostic setup:

```json
{
  "messages": {
    "responsePrefix": "*{identityName}:*\n\n",
    "responseFooter": "↑{input} ↓{output} R{total} {contextPercent}% ctx {model} · {effort}\n— {identityName}"
  }
}
```

A custom `/usage`-style footer that suppresses the built-in usage line automatically:

```json
{
  "agents": {
    "defaults": {
      "responseUsage": "full"
    }
  },
  "messages": {
    "responseFooter": "{usageLine} · {cost}"
  }
}
```
