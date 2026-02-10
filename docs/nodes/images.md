---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Image and media handling rules for send, gateway, and agent replies"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Modifying media pipeline or attachments（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Image and Media Support"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Image & Media Support — 2025-12-05（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The WhatsApp channel runs via **Baileys Web**. This document captures the current media handling rules for send, gateway, and agent replies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send media with optional captions via `openclaw message send --media`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Allow auto-replies from the web inbox to include media alongside text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep per-type limits sane and predictable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI Surface（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw message send --media <path-or-url> [--message <caption>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--media` optional; caption can be empty for media-only sends.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `--dry-run` prints the resolved payload; `--json` emits `{ channel, to, messageId, mediaUrl, caption }`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## WhatsApp Web channel behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Input: local file path **or** HTTP(S) URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Flow: load into a Buffer, detect media kind, and build the correct payload:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **Images:** resize & recompress to JPEG (max side 2048px) targeting `agents.defaults.mediaMaxMb` (default 5 MB), capped at 6 MB.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **Audio/Voice/Video:** pass-through up to 16 MB; audio is sent as a voice note (`ptt: true`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - **Documents:** anything else, up to 100 MB, with filename preserved when available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp GIF-style playback: send an MP4 with `gifPlayback: true` (CLI: `--gif-playback`) so mobile clients loop inline.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- MIME detection prefers magic bytes, then headers, then file extension.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Caption comes from `--message` or `reply.text`; empty caption is allowed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Logging: non-verbose shows `↩️`/`✅`; verbose includes size and source path/URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Auto-Reply Pipeline（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `getReplyFromConfig` returns `{ text?, mediaUrl?, mediaUrls? }`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When media is present, the web sender resolves local paths or URLs using the same pipeline as `openclaw message send`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multiple media entries are sent sequentially if provided.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Inbound Media to Commands (Pi)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When inbound web messages include media, OpenClaw downloads to a temp file and exposes templating variables:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `{{MediaUrl}}` pseudo-URL for the inbound media.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `{{MediaPath}}` local temp path written before running the command.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When a per-session Docker sandbox is enabled, inbound media is copied into the sandbox workspace and `MediaPath`/`MediaUrl` are rewritten to a relative path like `media/inbound/<filename>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media understanding (if configured via `tools.media.*` or shared `tools.media.models`) runs before templating and can insert `[Image]`, `[Audio]`, and `[Video]` blocks into `Body`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Audio sets `{{Transcript}}` and uses the transcript for command parsing so slash commands still work.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Video and image descriptions preserve any caption text for command parsing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- By default only the first matching image/audio/video attachment is processed; set `tools.media.<cap>.attachments` to process multiple attachments.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Limits & Errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Outbound send caps (WhatsApp web send)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Images: ~6 MB cap after recompression.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Audio/voice/video: 16 MB cap; documents: 100 MB cap.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Oversize or unreadable media → clear error in logs and the reply is skipped.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Media understanding caps (transcription/description)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Image default: 10 MB (`tools.media.image.maxBytes`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Audio default: 20 MB (`tools.media.audio.maxBytes`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Video default: 50 MB (`tools.media.video.maxBytes`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Oversize media skips understanding, but replies still go through with the original body.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes for Tests（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cover send + reply flows for image/audio/document cases.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Validate recompression for images (size bound) and voice-note flag for audio.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure multi-media replies fan out as sequential sends.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
