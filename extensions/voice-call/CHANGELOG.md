# Changelog

## 0.1.0

### Highlights
- Initial release of the @clawdbot/voice-call plugin.

### Changes
- Providers: Twilio (Programmable Voice + Media Streams), Telnyx (Call Control v2), and mock dev provider.
- Outbound calls: notify mode with auto-hangup + conversation mode for multi-turn calls.
- Inbound calls: policies (disabled/allowlist/open), allowlist matching, and inbound greeting.
- Webhooks: local server with configurable bind/port/path plus publicUrl override.
- Exposure: ngrok and Tailscale (serve/funnel) tunnel helpers; dev-only signature bypass for ngrok free tier.
- Streaming: OpenAI Realtime STT with media stream WebSocket + partial/final transcripts.
- Speech: OpenAI TTS (model/voice/instructions) with Twilio <Say> fallback.
- Tooling: `voice_call` tool with action-based API for initiate/continue/speak/end/status.
- CLI: `clawdbot voicecall` commands (call/start/continue/speak/end/status/tail/expose).
- RPC: gateway methods (`voicecall.initiate|continue|speak|end|status` + legacy `voicecall.start`).
- Persistence: JSONL call logs with `voicecall tail` for live inspection.
