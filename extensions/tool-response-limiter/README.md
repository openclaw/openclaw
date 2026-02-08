# Tool Response Limiter Plugin

A plugin for OpenClaw that limits the size of tool responses before they are persisted to session transcripts.

## Purpose

Large tool responses can consume significant context space and lead to:

- Increased token costs
- Slower processing
- Context window exhaustion

This plugin automatically truncates tool responses that exceed a configurable size threshold, preserving the most important information while indicating where truncation occurred.

## Features

- **Configurable size limit**: Set maximum response size in KB (default: 30KB)
- **Tool exemptions**: Specify tools that should bypass size limits
- **Clear truncation messages**: Responses include "[Response truncated from X to Y bytes]"
- **Structure preservation**: Attempts to preserve message structure while truncating content
- **Enable/disable toggle**: Can be disabled without removing from config

## Configuration

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "tool-response-limiter": {
      "enabled": true,
      "maxResponseSizeKb": 30,
      "exemptTools": ["image", "screenshot"]
    }
  }
}
```

### Options

- `enabled` (boolean, default: true): Enable or disable the plugin
- `maxResponseSizeKb` (number, default: 30): Maximum size for tool responses in kilobytes
- `exemptTools` (array, default: []): List of tool names to exempt from size limits

## How It Works

1. Hooks into the `tool_result_persist` event
2. Checks the serialized size of each tool response
3. If over the threshold:
   - Truncates text content intelligently
   - Removes or simplifies large detail objects
   - Adds a clear truncation message
4. Returns the modified message for persistence

## Priority

Runs at priority 100 (high priority) to ensure it processes responses before other transformation hooks.

## Examples

### Before Truncation

```
[Response with 150KB of data...]
```

### After Truncation

```
[Response with first 30KB of data...]

[Response truncated from 150.0 KB to ~30.0 KB]
```

## Development

The plugin is implemented in TypeScript and follows the standard OpenClaw plugin structure:

- `openclaw.plugin.json`: Plugin manifest with config schema
- `tool-response-limiter.ts`: Main plugin implementation
- `README.md`: Documentation

## License

Same as OpenClaw main repository.
