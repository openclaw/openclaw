## Summary

Add an opt-in Feishu streaming delivery mode that flushes accumulated model output at pause points instead of changing the existing streaming card behavior.

## Motivation

Feishu currently uses `channels.feishu.streaming` for CardKit live streaming. That behavior is useful, but some workflows need a different delivery style: collect text while the model is actively generating, then send a complete segment only when the model pauses for a tool call, idle event, block event, or final reply.

This PR keeps the existing `streaming: true` behavior unchanged and adds a new explicit mode for the new semantics.

`streaming` remains the top-level enable/disable switch for Feishu streaming delivery. `streamingMode` only applies when `streaming` is enabled.

## Changes

- Add `channels.feishu.streamingMode` with supported values:
  - `"card"`: default, existing CardKit streaming behavior
  - `"segment"`: accumulate model text and flush at pause points
- Preserve current `channels.feishu.streaming` semantics:
  - `true` enables streaming delivery
  - `false` disables streaming delivery
  - default mode remains CardKit streaming
- In segment mode:
  - partial model output is accumulated
  - accumulated text is flushed on tool start, idle, block, tool payload, or final reply
  - duplicate final text after an idle flush is suppressed
  - segment sends are serialized so final/tool payloads cannot overtake an in-flight partial flush
  - each flushed segment independently uses `renderMode: "auto"`
  - mentions are attached only to the first text segment
  - reasoning preview callbacks stay disabled because segment mode does not use live cards
- Update Feishu config schema, generated config metadata, docs, and tests.

## Example

Behavior by configuration:

| `streaming` | `streamingMode` | Behavior                                                                                                                                                |
| ----------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `false`     | `"card"`        | Streaming is disabled. Feishu sends replies through the regular non-streaming path; the mode value is ignored.                                          |
| `false`     | `"segment"`     | Streaming is disabled. Partial text is not accumulated and pause-point segment flushing is not enabled; the mode value is ignored.                      |
| `true`      | `"card"`        | Existing CardKit streaming behavior. Feishu updates one live card and closes it with the final content.                                                 |
| `true`      | `"segment"`     | New pause-point segment behavior. Feishu accumulates partial text and sends complete segments on tool start, idle, block, tool payload, or final reply. |

Use segment delivery with:

```json5
{
  channels: {
    feishu: {
      streaming: true,
      streamingMode: "segment",
    },
  },
}
```

Default behavior remains:

```json5
{
  channels: {
    feishu: {
      streaming: true,
      streamingMode: "card",
    },
  },
}
```

## Tests

```bash
node_modules/.bin/vitest run --config test/vitest/vitest.extension-feishu.config.ts extensions/feishu/src/reply-dispatcher.test.ts extensions/feishu/src/streaming-card.test.ts extensions/feishu/src/config-schema.test.ts --reporter=dot
```

Result:

- 3 test files passed
- 83 tests passed

After fixing segment ordering/deduplication, also ran:

```bash
pnpm test extensions/feishu/src/reply-dispatcher.test.ts
```

Result:

- 1 test file passed
- 49 tests passed

Also ran:

```bash
git diff --check -- extensions/feishu/src/config-schema.ts extensions/feishu/src/config-schema.test.ts extensions/feishu/src/reply-dispatcher.ts extensions/feishu/src/reply-dispatcher.test.ts src/config/bundled-channel-config-metadata.generated.ts docs/channels/feishu.md
```
