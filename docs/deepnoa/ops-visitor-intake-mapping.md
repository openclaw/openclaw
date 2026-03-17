# Ops Visitor Intake Mapping

## Why ops owns the first version

- ops already handles checks, cron, service triage, and operational exceptions
- intake trigger handling is closer to operational triage than to product development
- this keeps the first version small and reversible

## Minimal ops behavior

When a Formspree webhook arrives, ops should:

1. treat it as one intake session
2. keep raw contact and inquiry fields internal
3. confirm trigger presence
4. classify the inquiry into one of:
   - inquiry
   - document_request
   - consultation
   - sales
   - other
5. keep `service` as a routing hint
6. emit `visitor.inquiry.detected`
7. optionally append a short internal-only note for later handoff

## Internal fields retained by ops

- email
- company
- phone
- service
- subject
- message

## Public-safe fields

Allowed for scene/event use:

- sender present or missing
- subject present or missing
- received timestamp
- coarse category
- source marker: `formspree`

Avoid in the first version:

- raw message body in public events
- phone number in public events
- full sender address in public events
- company name in public events
- long summaries copied into public channels

## Future expansion

- dedicated `intake` agent
- richer routing to business roles via `service`
- scene/runtime feedback when ops is actively responding
