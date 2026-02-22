# @openclaw/image-strip

Image block auto-strip extension for openclaw — automatic recovery when
models return empty responses due to image content.

## Enabling the Plugin

This plugin is **not loaded by default**. Add it to the `plugins.entries` section of your openclaw config with `enabled: true`:

```jsonc
{
  "plugins": {
    "entries": {
      "image-strip": {
        "enabled": true,
        "config": {
          "imageStripEnabled": true,
          "imageStripPersist": true
        }
      }
    }
  }
}
```

## Features

| Feature | Description |
|---------|-------------|
| **Image strip** | Replaces image content blocks with `[image omitted]` placeholder when the model returns an empty response, both in-memory and on disk. |
| **Session persistence** | Strips images from persisted JSONL session files to prevent reload of problematic images on subsequent prompts. |
| **Empty message cleanup** | Removes empty assistant messages left by previous failed prompts. |

## Configuration

```jsonc
{
  "imageStripEnabled": true,   // Enable auto image stripping (default: true)
  "imageStripPersist": true    // Also strip images from session files on disk (default: true)
}
```

## Exported API

| Export | Description |
|--------|-------------|
| `ImageStripResult` | Type: `{ messages, hadImages }` |
| `stripImageBlocksFromMessages(msgs)` | In-memory image block replacement |
| `stripImageBlocksFromSessionFile(path)` | On-disk JSONL session file image stripping |
| `isEmptyAssistantContent(msg)` | Check whether an assistant message has no meaningful content |

## Development

```bash
cd extensions/image-strip
npm test
```
