# Direct Inquiry Intake via deepnoa.com/bot

## Goal

Use the existing `deepnoa.com/bot/` entrypoint as the public-facing webhook surface for website inquiries,
while keeping OpenClaw's internal hook contract simple.

## Recommended public route

Public URL:

- `/bot/hooks/formspree`

Internal OpenClaw route:

- `/hooks/formspree`

## Why this split is natural

- OpenClaw already exposes a generic `/hooks/*` surface.
- `deepnoa.com/bot/` is the public brand-facing path where external bot-connected endpoints already belong.
- Reverse proxy or ingress can map `/bot/hooks/formspree` -> `127.0.0.1:19001/hooks/formspree`.
- This avoids hard-coding `/bot` assumptions into OpenClaw itself.

## Existing route patterns to align with

- LINE webhook uses channel-specific pathing such as `/line/webhook`.
- Generic automation/webhook intake uses `/hooks/*`.
- Therefore inquiry intake is a better fit for `/hooks/formspree` than for a new channel namespace.

## Corporate site options

### Option A: Formspree + OpenClaw dual write

Corporate site sends the same inquiry to:

- Formspree
- OpenClaw webhook

Pros:

- safest rollout
- keeps existing email fallback
- easy comparison during migration

Cons:

- duplicate delivery paths
- slightly more frontend complexity

### Option B: Direct POST to OpenClaw only

Corporate site sends inquiry only to OpenClaw.

Pros:

- clean architecture
- no external dependency in primary path
- one source of truth for intake session

Cons:

- higher rollout risk
- if OpenClaw webhook is unreachable, inquiry intake fails unless retry/fallback is added

## Recommended rollout

1. Start with Option A.
2. Keep Formspree as fallback while validating direct intake.
3. After stable logs and ops handling, move to Option B if desired.

## Minimal direct intake flow

1. Corporate site form submits:
   - `email`
   - `company`
   - `phone`
   - `service`
   - `message`
2. Public endpoint receives:
   - `https://deepnoa.com/bot/hooks/formspree`
3. Reverse proxy forwards to:
   - `http://127.0.0.1:19001/hooks/formspree`
4. OpenClaw creates:
   - one `formspree_intake_session`
   - one public-safe `visitor.inquiry.detected`
5. `ops` receives first intake ownership.
6. Scene later reacts only to the public-safe visitor event.

## Repo changes by phase

### Phase 1: OpenClaw repo

- keep `POST /hooks/formspree`
- keep intake session + `visitor.inquiry.detected`
- optionally add signature/shared-secret validation for public ingress

### Phase 2: deepnoa corporate site repo

- replace direct Formspree fetch with dual write or direct OpenClaw POST
- keep payload shape aligned with intake session:
  - `email`
  - `company`
  - `phone`
  - `service`
  - `message`

### Phase 3: ingress / onamae side

- publish `/bot/hooks/formspree`
- forward only that path to OpenClaw gateway
- keep gateway loopback-bound if reverse proxy terminates externally

## Security note

For public production use, direct webhook intake should not stay completely unauthenticated forever.
Natural next step:

- add shared secret or signing validation at `/hooks/formspree`
- or validate only through reverse proxy allowlisting

## Recommendation summary

- Natural public route: `/bot/hooks/formspree`
- Natural internal route: `/hooks/formspree`
- Best first rollout: keep Formspree and add OpenClaw direct POST in parallel
- Best eventual architecture: direct POST to OpenClaw as primary, Formspree optional fallback
