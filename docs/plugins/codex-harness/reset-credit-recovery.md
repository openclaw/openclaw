---
summary: "Earned Codex quota reset credits: experimental implementation under review"
title: "Earned reset-credit recovery (draft)"
---

# Earned reset-credit recovery (draft)

This document accompanies a **draft implementation** that is **not yet wired to
a live turn or account-recovery path**. Do not enable it expecting automatic
recovery. It must not be merged as a usable feature until the outstanding
native runtime integration, live authority fencing, and replay checks are
implemented and validated.

## Proposed opt-in

```json
{
  "plugins": {
    "entries": {
      "codex": {
        "config": {
          "resetCreditRecovery": {
            "enabled": false,
            "maxPer24Hours": 1
          }
        }
      }
    }
  }
}
```

The setting is disabled by default. After the draft is integrated and validated,
explicitly enabling it will permit OpenClaw to **spend finite earned Codex reset
credits**. The global rolling 24-hour maximum is enforced atomically by the
new SQLite-backed plugin-state ledger; the parser currently limits the configured
maximum to 1–10. **Enabling the setting in this draft still does not dispatch
consumption**, because no live request path invokes the new policy.

Earned reset credits are separate from paid monetary credits, ordinary scheduled
quota renewal, OAuth token refresh, and locally cleared cooldowns.

## Required operational boundaries

The existing auth-profile owner must select all authorized, usable candidates
before any credit is spent, honor explicit account pins and per-agent isolation,
and recheck the complete permitted chain after durable ownership is acquired.
The consuming client must use the official Codex app-server methods
`account/rateLimits/read` and `account/rateLimitResetCredit/consume`.
A positive `rateLimitResetCredits.availableCount` must coexist with an
authoritatively eligible limit; absent or malformed data is never interpreted
as zero or permission to spend.

The shared SQLite recovery record must contain a stable idempotency key **before**
dispatch. Concurrent Gateway processes must claim the same logical attempt.
A timeout, cancellation after possible dispatch, unknown outcome, lost write
receipt, or restart must not cause a second credit to be consumed under a new
key. The four protocol outcomes are `reset`, `alreadyRedeemed`,
`nothingToReset`, and `noCredit`. Only a new authoritative rate-limit read
may re-enable a profile. Do not clear blocks solely based on RPC success.

Automatic resume must use the existing native replay and completed-side-effect
policy, never an unconditional `turn/start` retry. Terminal failure must keep
the currently configured fallback and suspension behavior.

## Implemented safeguards in this draft

The pure policy in `reset-credit-recovery.ts` inspects every profile in the
*already-authorized* ordered chain before and after claiming a reset. It will
not spend if a later profile is available, or if any allowed profile has an
unresolved/non-quota failure. It uses the authoritative
`ordinaryUsageAllowed` and `rateLimitReachedType` fields rather than inferring
permission from an exhausted percentage, and refuses spending merely because
purchased monetary credits exist. It keeps the four official consume outcomes
distinct and reads limits again following each.

The `reset-credit-ledger.ts` adapter uses OpenClaw's worker-backed
`PluginStateKeyedStore` version 2, `observe` and `compareAndApply` to
atomically claim a logical attempt and write the UUID idempotency key before
RPC dispatch. The ledger has a shared namespace,
`codex-earned-reset-ledger`, and serializes credit spending across accounts
of the same state store. A second process can reclaim a stale attempt using
**the original** idempotency key and a new lease token; stale writers may not
settle the reclaimed attempt. Unresolved attempts are never pruned.
Completed attempts count toward the rolling cap; no-op attempts do not.
A limited polling join supports per-caller timeouts and cancellation.

Credit detail rows are potentially capped. A complete, valid list selects the
earliest expiration (with `expiresAt: null` treated as never expiring). When
details are capped or count-only, it delegates selection to the documented
server behavior without claiming to know the earliest credit. Contradictory
and expired detail rows prevent a spend.

The bundled sample's independent JSON store and stale file-lock replacement
were intentionally **not** adopted: they would bypass current OpenClaw SQLite
ownership and could allow an expired lock to be removed while an in-flight
effect is still running.

## Work still required before merging

The SQLite ledger and policy are now present as separately testable source
modules, but they are **not yet registered or invoked by the live Gateway**.
The final host-owned integration must resolve authenticated profile identity
and credential generation, provide final-effect authority checks, open the
shared state store, choose the account through the current auth owner and wire
the selected Codex app-server client. The native turn/replay owner must resume
only when it can prove no prior side effects were committed or uncertain.

The tests currently model competing callers and compare-and-apply operations;
**they are not a real two-process SQLite/Gateway integration test**. The
source-tree Vitest tests, type checks, formatter, build, security guard, and
end-to-end recovery flow still need to run successfully against this PR head.
A maintainer decision is also needed on the core-auth to bundled-plugin
boundary. No live reset credits or user messages are consumed or sent here.

Related (not fixed): [reset-credit inventory proposal #163413](https://github.com/openclaw/openclaw/issues/163413).
The inventory issue is read-only and requires a separate product decision on
public API placement.
