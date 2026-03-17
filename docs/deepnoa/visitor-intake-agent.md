# Visitor Intake Agent Draft

## Goal

Create a minimal intake path so OpenClaw can treat one external inquiry as one intake session, classify it, and emit a public-safe visitor event without exposing inquiry content publicly.

## Current OpenClaw State

- Main repo: `~/openclaw`
- Working branch: `codex/feat-visitor-intake-agent`
- Existing role agents:
  - `dev`: development work
  - `ops`: operations and service triage
  - `research`: research and briefing work
- Best initial landing point: `ops`
  - reason: already owns monitoring, cron, checks, and operational triage

## Recommended Minimal Path

1. Formspree sends one webhook delivery to `POST /hooks/formspree`.
2. OpenClaw accepts the full webhook payload.
3. Gateway normalizes it into one `formspree_intake_session`.
4. Intake logic extracts:
   - public-safe visitor event
   - contact presence flags
   - raw internal fields for ops
   - routing hint from `service`
5. `ops` receives the intake first.
6. Scene uses only the public-safe event.

## Stage 0 Direct Formspree Webhook

- Endpoint: `POST /hooks/formspree`
- Current behavior:
  - accepts `application/json`
  - accepts `application/x-www-form-urlencoded`
  - accepts `multipart/form-data`
  - always returns `200`
  - logs receipt under gateway hooks logs
  - emits `visitor.inquiry.detected`
  - creates one internal `formspree_intake_session`
  - dispatches a private intake hook run to `ops`

## Public-safe event shape

- `type`: `visitor.inquiry.detected`
- `source`: `formspree`
- `received_at`
- `has_sender`
- `has_subject`
- `category`

## Internal intake session shape

See:

- `docs/deepnoa/formspree-intake-session.md`

## Why ops first

- intake trigger handling is closer to operational triage than product development
- keeps first version small
- can later split into a dedicated `intake` agent without changing scene semantics

## Future stages

### Stage 1

- keep `ops` as the first owner
- classify by message + subject + service
- emit scene-safe visitor event only

### Stage 2

- add dedicated `intake` agent
- move classification and handoff logic into `intake`
- route based on `service` + category

### Stage 3

- connect visitor event to scene runtime state
- add dedicated public-safe summary generation if needed

## Current exposure note

The gateway is still loopback-bound on port `19001`, so Formspree cannot reach it directly from the public internet yet.
For live Formspree delivery, add one of:

- ngrok or similar HTTPS tunnel to `127.0.0.1:19001`
- a reverse proxy/public webhook endpoint that forwards only `/hooks/formspree`
- a dedicated webhook ingress host
