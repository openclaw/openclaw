# Comms adapter (Twilio) plan

## Inbound

- Validate webhook signature.
- Normalize into CommsEnvelope.
- Persist envelope and link to ticket (if phone-to-contact mapping exists).
- Create timeline entry and/or evidence record with provider raw payload.

## Outbound

- Outbound send is a DispatchCommand:
  - policy-gated (quiet hours, customer status)
  - audited
- Store delivery status callbacks as evidence.

## Safety

- Treat signature failures as security events (drop, alert).
- Enforce per-tenant rate limits and quiet hours rules.
