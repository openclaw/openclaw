# Phase 8: Browser, Media & Telegram — Context

**Gathered:** 2026-02-16
**Status:** Ready for planning

<domain>
## Phase Boundary

Get external service integrations working end-to-end: Browserless CDP browser sessions and Telegram messaging. Verify existing live tests pass and create new ones where missing. Deepgram audio transcription is deferred — user skipping for now.

**Scope change from roadmap:** WhatsApp replaced with Telegram (user has Telegram, not WhatsApp). Deepgram deferred.

</domain>

<decisions>
## Implementation Decisions

### Browser (Browserless)
- User will run Browserless locally via Docker (`docker run browserless/chrome`)
- Existing live test (`pw-session.browserless.live.test.ts`) should be verified against local Docker instance
- Env var: `OPENCLAW_LIVE_BROWSER_CDP_URL` points to local Docker endpoint
- No hosted service — purely local testing

### Telegram End-to-End
- Full message loop: send message → gateway receives → agent processes → reply appears in Telegram
- Bot token and test chat already available
- Target: private chat with the bot (not group)
- New live test file needed — follow `describeLive` pattern from Phase 6
- Env vars: Telegram bot token (already configured)

### Deepgram Audio
- Skipped for this phase — user does not want to set up Deepgram right now
- Existing live test file remains but won't be targeted

### Claude's Discretion
- Docker setup instructions (if any documentation is needed)
- Telegram live test file structure and assertions
- How to trigger the agent processing step in the test
- Timeout and retry configuration for external service calls

</decisions>

<specifics>
## Specific Ideas

- Telegram test should prove the full round-trip: message in → agent response out
- Browser test just needs to confirm the existing test passes against local Docker Browserless
- Keep it simple — these are verification tests, not comprehensive integration suites

</specifics>

<deferred>
## Deferred Ideas

- Deepgram audio transcription testing — user may revisit later
- WhatsApp e2e testing — user doesn't have WhatsApp set up
- Group chat Telegram testing — only private chat for now

</deferred>

---

*Phase: 08-browser-media-whatsapp*
*Context gathered: 2026-02-16*
