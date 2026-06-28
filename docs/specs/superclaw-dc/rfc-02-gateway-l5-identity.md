# RFC-02: Gateway and L5 Identity Boundary

Status: draft

Date: 2026-06-27

Depends on:

- `rfc-00-control-spine.md`
- `rfc-01-tenant-isolation.md`

## Summary

L5 channel adapters may normalize channel events, but they must not independently create canonical principal context unless they run inside the gateway trust boundary.

This RFC defines two valid trust modes and the `AliasAssertion` contract for adapters outside the gateway boundary.

## Problem

Channel identity is platform-local:

- Telegram sender ID
- Slack user/team ID
- Teams/M365 tenant/user ID
- email address/message ID
- LiveKit participant/session ID
- Rasa conversation/user ID

These are not Superclaw canonical principals. They need binding, freshness, revocation, replay protection, and cell-aware routing before they can enter L4/L6 policy.

## Valid Trust Modes

### Mode A: In-Boundary Adapter

Adapter runs inside gateway-controlled trust boundary.

Examples:

- gateway-owned channel plugin;
- sidecar authenticated by SPIFFE and authorized for one cell;
- trusted ingress service in same isolation cell.

Rule:

```text
adapter may provide normalized channel facts;
gateway still constructs SuperclawRequestContext;
adapter may not provide caller-controlled org/cell fields without route-table check.
```

### Mode B: Out-of-Boundary Adapter

Adapter runs outside gateway trust boundary.

Examples:

- SaaS webhook processor;
- separate L5 channel bridge;
- edge device collecting voice/session events;
- offline hybrid bridge replaying queued channel events.

Rule:

```text
adapter must present signed AliasAssertion;
gateway verifies signature, issuer, audience, replay, binding epoch, and route mapping;
only then gateway can construct SuperclawRequestContext.
```

## AliasAssertion v0

Logical payload:

```json
{
  "schema": "superclaw.alias_assertion.v0",
  "iss": "l5-adapter:telegram:prod",
  "aud": "gw-usw2-a-01",
  "exp": 1782600000,
  "iat": 1782599700,
  "jti": "aa_01J...",
  "channel": "telegram",
  "channel_account_id": "bot-prod-1",
  "channel_conversation_id": "-1003759657220",
  "channel_sender_id": "293894843",
  "channel_message_id": "11891",
  "engagement_id": "eng_01J...",
  "alias_binding_event_id": "abe_01J...",
  "binding_epoch": 42,
  "canonical_principal_id": "principal_01J...",
  "org_id": "org_01J...",
  "customer_tenant_id": "cust_01J...",
  "isolation_cell_id": "cell-usw2-a",
  "nonce": "n_01J..."
}
```

Encoding:

- JWS or COSE Sign1.
- Payload canonical JSON or CBOR.
- `kid` points to adapter signing key.
- `aud` is gateway ID or isolation-cell gateway audience.

## Gateway Verification

Gateway must check:

```text
signature valid for issuer/kid
issuer allowed for channel/account/cell
audience matches gateway or served cell
exp/iat within clock policy
jti not replayed
alias_binding_event_id exists
binding_epoch equals current registry epoch
binding not revoked/superseded/recycled-risk
canonical_principal_id active in org
org/customer/cell match routing table
channel account allowed for org/customer/cell
```

Any failure means no `SuperclawRequestContext`.

## Alias Binding Registry

Registry record:

```yaml
alias_binding_event_id: abe_01J...
state: bound | unbound | superseded | reverified | recycled-risk | revoked
binding_epoch: 42
canonical_principal_id: principal_01J...
org_id: org_01J...
customer_tenant_id: cust_01J...
isolation_cell_id: cell-usw2-a
channel: telegram
channel_account_id: bot-prod-1
channel_sender_id: "293894843"
created_at:
updated_at:
expires_at:
proof_ref:
signed_by:
prev_event_hash:
event_hash:
```

Registry owner: L6 identity/org plane. Gateway caches read-only snapshots with epoch invalidation.

## Replay Model

Replay cache key:

```text
iss + aud + jti
```

Replay TTL:

```text
max(assertion_exp - now, minimum_replay_window)
```

Fail mode:

- replay cache unavailable: fail closed for material actions;
- clock skew above allowed bound: fail closed;
- stale binding epoch: fail closed.

## Context Projection

Gateway writes these fields into `SuperclawRequestContext`:

```yaml
identity:
  org_id:
  customer_tenant_id:
  isolation_cell_id:
  canonical_principal_id:
  channel_alias_id:
  channel_id:
  engagement_id:
  alias_binding_event_id:
  alias_binding_epoch:
  alias_assertion_hash:
```

Raw channel facts may be included under `channel.facts`, but policy must not treat raw facts as canonical identity.

## Outbound / Proactive

For proactive outbound, gateway must resolve from canonical principal to allowed channel alias:

```text
principal_id + org_id + purpose + consent scope
  -> active alias binding
  -> channel account route
  -> PDP send authorization
  -> ActionReceipt
  -> MessageReceipt
```

No proactive send may use stale alias binding after:

- unbound;
- superseded;
- recycled-risk;
- opt-out;
- channel account revoked;
- consent expired.

## Tests

Required negative tests:

1. unsigned assertion rejected.
2. wrong audience rejected.
3. replayed `jti` rejected.
4. stale `binding_epoch` rejected.
5. revoked binding rejected.
6. assertion cell differs from route table rejected.
7. raw channel sender ID cannot create context.
8. proactive send after alias unbound rejected.

Required positive test:

1. live binding + valid assertion + route match creates context with expected principal/org/customer/cell.

## Open Questions

1. Exact signing format: JWS vs COSE.
2. Whether alias registry events should follow OpenID Shared Signals subject/event profile directly.
3. Whether L5 adapters get per-channel signing keys or per-account signing keys.
4. How offline hybrid bridge proves queue ordering and anti-replay after reconnect.
