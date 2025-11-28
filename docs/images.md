# Image Support Specification — 2025-11-25

This document defines how `warelay` should handle sending and replying with images across both providers. It is intentionally implementation-ready and keeps the UX consistent with existing CLI patterns and Tailscale Funnel usage.

## Goals
- Allow sending an image with an optional caption via `warelay send` for both providers.
- Allow auto-replies (Twilio webhook, Twilio poller, Web inbox) to return an image (optionally with text) when configured.
- For the Web provider, also support audio/voice, video, and generic documents with sensible per-type limits.
- Keep the “one command at a time” queue intact; media fetch/serve must not block other replies longer than necessary.
- Avoid introducing new external services: reuse the existing Tailscale Funnel port to host media for Twilio.

## CLI & Config Surface
- `warelay send --media <path-or-url> [--message <caption>] [--provider twilio|web]`
  - `--media` optional; `--message` remains required for now (caption can be empty string to send only media).
  - `--dry-run` prints the resolved payload including hosted URL (twilio) or file path (web).
  - `--json` emits `{ provider, to, sid/messageId, mediaUrl, caption }`.
- Config auto-reply (`~/.warelay/warelay.json`):
  - Add `inbound.reply.mediaUrl?: string` (templated like `reply.text`).
  - Return shape from `getReplyFromConfig` becomes `{ text?: string; mediaUrl?: string }`.
  - Both `text` and `mediaUrl` optional; at least one must be present to send a reply.

## Provider Behavior
### Web (Baileys)
- Input: local file path **or** HTTP(S) URL.
- Flow: load into Buffer, detect media kind, and apply the right payload:
  - Images: **resize + recompress to JPEG** (max side 2048px, quality step-down) to fit under `inbound.reply.mediaMaxMb` (default 5 MB) but never above the Web hard cap (6 MB).
  - Audio/voice and video: pass through up to 16 MB; set `ptt: true` for audio to send as a voice note.
  - Everything else becomes a document with filename, up to 100 MB.
- MIME is detected by magic bytes first (then header, then path); wrong file extensions are tolerated and the detected MIME drives payload kind and recompression.
- Caption uses `--message` or `reply.text`; if caption is empty, send media-only.
- Logging: non-verbose shows `↩️`/`✅` with caption; verbose includes `(media, <bytes>B, <ms>ms fetch)` and the local/remote path.

### Twilio
- Twilio API requires a public HTTPS `MediaUrl`; it will not accept local paths.
- Hosting strategy: reuse the webhook/Funnel port.
- When `--media` is a local path, copy to temp dir (`~/.warelay/media/<uuid>`), serve at `/media/<uuid>` on the existing Express app started for webhook, or spin up a short-lived server on demand for `send`.
  - `MediaUrl` = `https://<tailnet-host>.ts.net/media/<uuid>`.
  - Files auto-removed after TTL (default 2 minutes) or after first successful fetch (best-effort).
  - Enforce size limit 5 MB (matches the media host guard); reject early with clear error.
- If `--media` is already an HTTPS URL, pass through unchanged.
- Fallback: if Funnel is not enabled (or host unknown) and a local path is provided, fail with guidance to run `warelay webhook --ingress tailscale` (or pass a URL instead).

## Hosting/Server Details
- Extend `startWebhook` Express app:
  - Static media route `/media/:id` reading from temp dir.
  - 404/410 if expired or missing.
  - Optional `?delete=1` to self-delete after fetch (used by Twilio fetch hook if we detect first hit).
- Temp storage: `~/.warelay/media`; cleaned on startup (remove files older than 15 minutes) and during TTL eviction.
- Security: no directory listing; only UUID file names; CORS open (Twilio fetch); content-type derived from sniffed bytes (fallback to header, then extension). Saved files are renamed with an extension that matches the detected MIME so downstream fetches present the correct type.

## Auto-Reply Pipeline
- `getReplyFromConfig` returns `{ text?, mediaUrl? }`.
- Webhook / Twilio poller:
  - If `mediaUrl` present, include `mediaUrl` in Twilio message payload; caption = `text` (may be empty).
  - If only `text`, behave as today.
- Web inbox:
  - If `mediaUrl` present, fetch/resolve same as send (local path or URL), send via Baileys with caption.

## Inbound Media to Commands (Claude etc.)
- For completeness: when inbound Twilio/Web messages include media, download to temp file, expose templating variables:
  - `{{MediaUrl}}` original URL (Twilio) or pseudo-URL (web).
  - `{{MediaPath}}` local temp path written before running the command.
- Size guard: only download if ≤5 MB; else skip and log (aligns with the temp media store limit).
- Saved inbound media is named with the detected MIME-based extension (e.g., `.jpg`), so later CLI sends reuse a correct filename/content-type even if WhatsApp omitted an extension.
- Audio/voice notes: if you set `inbound.transcribeAudio.command`, warelay will run that CLI (templated with `{{MediaPath}}`) and replace `Body` with the transcript before continuing the reply flow; verbose logs indicate when transcription runs. The command prompt includes the original media path plus a `Transcript:` section so the model sees both.

## Errors & Messaging
- Local path with twilio + Funnel disabled → error: “Twilio media needs a public URL; start `warelay webhook --ingress tailscale` or pass an https:// URL.”
- File too large → error mentions the applicable cap (5 MB for Twilio host, 6/16/100 MB for Web image/audio-video/doc respectively).
- Download failure for web provider → “Failed to load media from <source>; skipping send.”

## Tests to Add
- Twilio: dry-run shows hosted URL; send payload includes `mediaUrl`; rejects when Funnel host missing.
- Web: local path sends image (mock Baileys buffer assertion).
- Config: zod allows `mediaUrl`, returns combined object; command auto-reply handles `text+media`, `media-only`.
- Media server: serves file, enforces TTL, returns 404 after cleanup.

## Open Decisions (confirm before coding)
- TTL for temp media (proposal: 2 minutes, cleanup at start + interval).
- One-file-per-send vs. batching: default to one-file-per-send; multi-attach not supported.
- Should `warelay send --provider twilio --media` implicitly start the media server (even if webhook not running), or require `warelay webhook` already active? (Proposal: auto-start lightweight server on demand, auto-stop after media is fetched or TTL.)
