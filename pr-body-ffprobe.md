## Summary

When `ffprobe`/`ffmpeg` is not installed on the host and a voice/audio message is received, the unhandled `ENOENT` error was propagating up and killing the agent WebSocket with close code 1006 (abnormal closure). Users would see the agent go offline instead of receiving a helpful error message.

## Details

Added `ENOENT` detection in `src/media/ffmpeg-exec.ts`. When ffprobe or ffmpeg binary is not found:

- A human-readable `MissingFfmpegError` is thrown with the message: `"Cannot process audio: ffprobe is not installed. Install ffmpeg to enable audio transcription."`
- This error is caught gracefully upstream instead of crashing the WebSocket
- The full error is logged internally via `logVerbose`

## Related Issues

Fixes #40382

## How to Validate

1. Ensure `ffprobe`/`ffmpeg` are NOT installed
2. Send a voice/audio message via Telegram
3. Confirm the agent responds with the helpful error message instead of going offline

Run unit tests: `pnpm test -- --testPathPattern=ffmpeg-exec`

## Pre-Merge Checklist

- [x] Updated relevant documentation and README (if needed)
- [x] Added/updated tests (if needed)
- [ ] Noted breaking changes (if any)
- [x] Validated on required platforms/methods:
  - [x] Windows
    - [x] npm run
