---
summary: "Versioned managed-research adapters over existing plugin RPC"
title: "Research adapters"
read_when:
  - Implementing or qualifying a managed research provider
---

Research semantics belong to the bundled feature and provider plugins, not the
Gateway or Plugin SDK. The feature's local typed contract binds explicitly to
`google.research.v1` over the existing trusted plugin RPC transport. Google
validates its request and native response at ingress; the feature consumes the
loaded provider's reply by reference. There is no new SDK adapter registry.

The feature owns logical jobs, polling, cancellation intent, recovery, budgets,
and stable result publication. A provider owns its endpoint, authentication,
remote handle and attribution parsing. `describe` distinguishes a full managed
research service from ordinary native search tools. Search grounding alone is
not a managed-research capability.

Requests use `{ version: 1, action: "describe" | "start" | "poll" | "cancel" }`.
Start carries `question`, optional `output` and `asOf`; poll/cancel carry the
provider's opaque `handle`. RPC parameters wrap this as `request`, alongside
`sessionKey` and `agentId` for the existing session-access policy. Responses have
`version: 1` and either `ok: true, value` or `ok: false, state, reason`.
Unknown versions, shapes, services, and unsupported constraints fail explicitly.

Google is activated through `plugins.entries.google.config.research`, with
`enabled: true` and an existing `profileId`. Registration loads no credentials
and makes no network calls. The provider requires the same pinned API-key
profile for start, poll and cancel. It rejects OAuth and profile substitution.
The provider persists an interaction binding to the original agent, session,
incarnation, profile, and credential account in its admitted plugin state. A
caller-supplied handle is only an identifier, not authority. Poll and cancel reject
foreign or stale owners before native HTTP; restarting with the same genuinely
current owner can reuse the recorded interaction without another submission.

Every external effect checks current session and provider authority after
preparation. Registered plugin RPC handlers receive `assertHandlerCurrent()` in
their options: combine this live provider-owner fence with session authority and
recheck after awaits and immediately before effects or report delivery. It retires
when the provider owner retires, before in-flight cleanup drains. Cleanup hooks
and possession of a remote handle do not authorize late publication.

A returned start receipt may be persisted as local bookkeeping under the live
provider/service owners even when the source borrow has closed. Persist only its
original binding and handle, never report content or permission to execute; later
polling still needs fresh authority. A newer or terminal job must not be overwritten.
If the provider owner retires or storage fails before its binding is committed, a
returned handle cannot bypass the ownership check on a later poll or cancel.
This receipt-before-binding window remains indeterminate and requires inspection
at the original provider account; automatic recovery does not reconstruct custody
from the handle alone or perform cancellation without current authority.
The same local custody boundary can retain a definitive not-sent outcome before
source delivery closes. A `blocked` start may include `retryAfterMs` only when the
refusal is temporary; an indeterminate transport outcome never authorizes another
submission. The feature bounds retries and reacquires authority each time,
including when the initial `describe` probe receives a retryable refusal.
The in-process dispatcher preserves canonical authority refusals from its own
source preparation as structured RPC errors before method work begins. It does
not reclassify errors from already-entered method work as proof of non-submission.
`isSessionAccessRefreshingError` from `openclaw/plugin-sdk/gateway-runtime`
recognizes only the canonical temporary session-preparation error. It is a bounded
retry hint, not a grant. Permanent session revocation remains blocked.

Provider citations attribute generated report text; they are not fetched source
passages. Their optional `startByte`/`endByte` offsets are UTF-8 bytes into the
report. Adapters must omit thought/tool traces, bound their outputs, preserve
partial states, and never infer successful cancellation from a successful HTTP
response alone. A create without a recorded remote receipt or definitive not-sent
outcome is indeterminate: there is no automatic submission retry without documented
provider idempotency.

See [Deep Research](/tools/deep-research) for user-facing behavior and qualification
limits. No consumer OAuth, Codex managed-research RPC, or cross-auth-mode proof
is implied by this contract.
