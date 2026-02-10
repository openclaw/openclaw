# Guard Model for Prompt Injection Sanitization

## Overview

The Guard Model is a lightweight security layer designed to sanitize untrusted external content before it reaches the main agent. This provides "true upstream isolation" against prompt injection attempts by using a secondary, cheap model (like Gemini Flash or Claude Haiku) to strip instructions while preserving factual data.

## How It Works

When external content (emails, web search results, tool outputs) is processed, it is passed through the guard model pipeline:

1. **Pre-check**: content is scanned for known suspicious patterns.
2. **Sanitization**: a dedicated model extracts only the factual data using a strict security prompt.
3. **Delivery**: the main agent receives the sanitized observation, preventing injection attempts from influencing its behavior.

## Configuration

Add the `guardModel` section to your agent configuration:

```json
{
  "security": {
    "guardModel": {
      "enabled": true,
      "model": "flash",
      "maxTokens": 500,
      "onFailure": "warn"
    }
  }
}
```

### Options

- `enabled`: Turn the guard model on/off (default: `false`).
- `model`: The model alias to use for sanitization (default: `flash`).
- `maxTokens`: Maximum length of sanitized output.
- `onFailure`: Action to take if the guard model fails (`passthrough`, `block`, or `warn`).
- `allowlist`: List of trusted sources (e.g., specific tool names) that bypass the guard.

## Benefits

- **Isolation**: Prevents "dirty" content from ever being seen by the main agent as instructions.
- **Cost-Effective**: Uses small, fast models to minimize latency and expense.
- **Defense in Depth**: Complements existing regex-based scanners and XML wrapping.
