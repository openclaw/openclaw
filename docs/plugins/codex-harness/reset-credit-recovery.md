---
summary: "Earned Codex quota reset credits: experimental implementation under review"
title: "Earned reset-credit recovery (draft)"
---

# Earned reset-credit recovery (draft)

This document accompanies a **draft implementation** that is **not yet wired to
a live turn or account-recovery path**. Do not enable it expecting automatic
recovery. It must not be merged as a usable feature until the outstanding
durable ownership, runtime integration, and replay checks are implemented and
validated.

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

The setting is disabled by default. Enabling it after completion would allow
OpenClaw to **spend finite, earned Codex reset credits**. The adjustable cap
limits paid-in-kind consumption across consecutive runs. It must be enforced
atomically in persistent shared account storage, not process memory.

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

## Work still required before merging

The draft currently has a policy engine, protocol types, config parsing, and
mocked contract tests. It does **not** have a production owner-backed SQLite
claim/settlement adapter, cross-process wait/cancellation coordination,
account-selection integration, a safely bounded replay/resume path, or real
Gateway flow proof. These must be developed and verified before this feature
can leave Draft. No real reset credits are used by its tests.

Related (not fixed): [reset-credit inventory proposal #163413](https://github.com/openclaw/openclaw/issues/163413).
The inventory issue is read-only and requires a separate product decision on
public API placement.
