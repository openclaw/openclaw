# PR Summary: Telegram sendMessage should accept `filePath/path` media aliases

## Problem
Telegram outbound runtime already supports:
- media sends
- document uploads
- caption
- reply threading
- `forceDocument`

However, the Telegram `sendMessage` action surface in `extensions/telegram/src/action-runtime.ts` only accepted:
- `mediaUrl`
- `media`

This caused a mismatch with other channels (notably Matrix and Discord-style action surfaces) that already accept:
- `media`
- `mediaUrl`
- `filePath`
- `path`

As a result, agent/tool calls using local-file style inputs (`filePath` / `path`) could work on some channels but fail to reach Telegram’s existing outbound media pipeline.

## Root cause
The missing piece was not Telegram runtime support.
Telegram runtime and outbound handling were already capable of sending documents/media.
The actual gap was at the **Telegram action surface mapping** in `extensions/telegram/src/action-runtime.ts`, which did not alias `filePath/path` into the existing `mediaUrl` input.

## Patch
### Code change
Updated Telegram `sendMessage` action param parsing in:
- `extensions/telegram/src/action-runtime.ts`

New alias order:
```ts
const mediaUrl =
  readStringParam(params, "media", { trim: false }) ??
  readStringParam(params, "mediaUrl", { trim: false }) ??
  readStringParam(params, "filePath", { trim: false }) ??
  readStringParam(params, "path", { trim: false });
```

This aligns Telegram with existing channel patterns and forwards local file-style inputs into the already-existing Telegram media send path.

### Tests added
Updated:
- `extensions/telegram/src/action-runtime.test.ts`

Added coverage for:
1. `filePath` alias -> maps to `mediaUrl`
2. `path` alias -> maps to `mediaUrl`
3. `asDocument` still maps to `forceDocument`

## Why this is minimal and safe
- No Telegram runtime media logic was rewritten
- No provider API shape was changed
- Existing `mediaUrl` behavior remains intact
- Existing text-only sends remain intact
- Existing `caption`, `replyToMessageId`, and `forceDocument` behavior remain intact

## Expected behavior after patch
Telegram `sendMessage` should accept any of:
- `media`
- `mediaUrl`
- `filePath`
- `path`

and route them through the same outbound media/document send path.

## Smoke tests to run after install
### success
- `sendMessage` with `mediaUrl`
- `sendMessage` with `filePath`
- `sendMessage` with `path`
- `sendMessage` with `filePath + asDocument`
- `sendMessage` with `caption + replyToMessageId`

### failure
- missing file path
- disallowed local path
- oversized file

## Current limitation
Repo dependencies were not yet installed in this environment, so full automated test execution could not be completed here. Source patch + source tests are in place and ready to run once dependencies are installed.
