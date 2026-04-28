## Summary

Syncs 30 commits from upstream (steipete/warelay) with 3 merge conflict resolutions, preserving fork-specific customizations while adopting upstream's architectural improvements.

## Key Changes

### Heartbeat Architecture Simplification

- **Removed `heartbeat-prehook` module** — Upstream consolidated heartbeat handling by adding an `isHeartbeat` flag to `GetReplyOptions` instead of a separate prehook system
- **Simplified Twilio monitor** — Removed ~150 lines of inline heartbeat timer/lock logic from `monitorTwilio()`, making it purely a polling loop
- **Heartbeat array normalization** — Heartbeat replies now properly handle array payloads for both web and Twilio paths

### Text Chunking for Long Messages

- **New `chunk.ts` module** — Splits outbound text at platform limits (1600 chars for Twilio, 4000 for web) with smart word/newline boundary detection
- **Prevents message truncation** — Long AI responses are now chunked into multiple messages instead of being silently cut off

### Tau RPC Process Management

- **New `tau-rpc.ts` module** — Keeps a single long-lived Pi agent process in RPC mode instead of spawning per message
- **Performance improvement** — Eliminates cold-start latency for Pi agent auto-replies
- **Streaming JSON handling** — Buffers output until assistant turn completes, preventing duplicate/partial messages

### Media Improvements

- **Follow redirects** — Media downloads now follow up to 5 redirects when fetching Twilio media
- **Post-response cleanup** — Media files are deleted immediately after the response finishes (not on a timer)
- **Redirect test coverage** — New `store.redirect.test.ts` for redirect handling

### Agent Enhancements

- **Gemini agent support** — New `gemini.ts` agent definition
- **Multi-text RPC outputs** — Command auto-replies now support agents returning multiple text chunks
- **Session metadata logging** — Agent/session context logged at command start

## Fork Customizations Preserved

Conflict resolutions kept fork-specific settings in AGENTS.md:

- tmux-based relay management (vs upstream's launchctl approach)
- `--provider twilio` preference for starting relay
- Global `warelay` command usage (vs `pnpm warelay`)

## Breaking Changes

None — the heartbeat-prehook removal is internal; external API remains unchanged.

## Files Deleted (upstream removal)

- `src/auto-reply/heartbeat-prehook.ts`
- `src/auto-reply/heartbeat-prehook.test.ts`

## Testing

Upstream tests pass. The merge was tested locally with conflict resolutions verified.
