# Changelog (GlobalCaos Fork)

All notable changes to this fork are documented here.

## [2026-02-03] - The Great Upgrade

### Security (Cherry-picked from upstream)
- **#7769** DNS Rebinding Protection — Prevents LAN attackers from hijacking sessions
- **#7616** Zip Path Traversal Fix — Closes file system vulnerability
- **#7704** WebSocket Auth Enforcement — Secures agent control channel

### Stability & Cost (Cherry-picked from upstream)
- **#7644** Gateway Rate Limiting — Prevents runaway API costs
- **#7770** Smart Router V2 — Auto model selection, 20-40% cost savings

### Skills Added
- **youtube-ultimate v1.0** — FREE YouTube transcripts (no API cost!), video details, search, comments
- **google-sheets** — Content calendars, spreadsheet automation (from kumarabhirup fork)
- **healthcheck** — System security auditing (from centminmod fork)

### Our Fixes
- **ceb8c9a8b** Anthropic failover patterns — Auto-switch to Gemini on rate limit (VERIFIED WORKING!)
- **bccd17ec9** Chrome auto-reattach — Browser extension remembers tabs
- **Chrome MV3 Fix** — State persists via `chrome.storage.session` (no more forgetting tabs on sleep)

### Removed
- **bear-notes** — macOS-only, not useful on Ubuntu

### Documentation
- **FORK.md** — Fork philosophy and advantages
- **docs/guides/first-time-setup.md** — Newcomer guide

---

## In Progress

### youtube-ultimate v2.0
- Adding yt-dlp integration for video/audio downloads
- New commands: `download`, `download-audio`, `formats`

### WhatsApp Full History
- Enabling `syncFullHistory` in Baileys
- Handling `messaging.history-set` events
- Config option: `channels.whatsapp.syncFullHistory: true`

### Additional PRs
- **#7695 + #7636** LanceDB Hybrid Memory
- **#7635** Browser Cookies Action
- **#7600** Secrets Injection Proxy
- **#7747** Zero-Latency Hot-Reload

---

## Philosophy

This fork follows a **trust-first approach**:
- No artificial sandboxing
- Full AI access to user data (with consent)
- Multi-model resilience (Claude + Gemini + Manus)
- Ubuntu/Linux as primary platform

We believe AI assistants should be **capable partners**, not restricted tools.

---

*Maintained by Oscar Serra (@globalcaos)*
