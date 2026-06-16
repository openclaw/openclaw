# fix(gateway): reject reserved target keywords (current/self/this/me) in message send [AI-assisted]

Fixes #91372

## What and why

Three production incidents were traced to agents passing the literal string `"current"` as the `send.to` field. The gateway's outbound target resolver (`resolveGatewayOutboundTarget`) interpreted this as a valid target and routed messages to the `@current` channel — the active conversation — instead of the intended destination. The same hazard exists for the sibling keywords `"self"`, `"this"`, and `"me"`, which share the same ambiguous-routing semantic.

This change adds a reserved-word guard **before** `resolveGatewayOutboundTarget` is called, immediately after the `to` string is extracted from the request (line ~633). If the case-folded `to` value is one of `{current, self, this, me}`, the handler responds with `INVALID_REQUEST` and returns — the inflight async work block is never entered.

**Over-rejection guard:** only the bare `send.to` string path is affected. Cron jobs that carry a `{mode: "current"}` struct and agent-config routes that use `{mode: "current"}` flow through completely different resolvers and are untouched by this change.

## Changes

- `src/gateway/server-methods/send.ts` — ~10 LOC guard inserted after `threadId` extraction, before `const work = (async ...)`.
- `src/gateway/server-methods/send.test.ts` — new `describe("gateway send reserved-target guard")` block with:
  - 12 parametrized cases covering all case variants (`current`, `Current`, `CURRENT`, `self`, …, `me`, `Me`, `ME`) asserting `INVALID_REQUEST` + `reserved` in the error message + `resolveOutboundTarget` NOT called.
  - 1 positive regression case asserting `telegram:C1234567890` reaches `resolveOutboundTarget` (guard does not fire).

## Real behavior proof

**Behavior or issue addressed:** `send.to = "current"` (and case variants + `self`/`this`/`me`) now returns `INVALID_REQUEST`; real targets like `"telegram:C1234567890"` still reach the outbound resolver unchanged.

**Real environment tested:** main `3d05da9a`, Node 24.7.0, pnpm 11.2.2, macOS; real `send` handler loaded from `./send.js`, not mocked — only outbound delivery dependencies are mocked (standard pattern throughout `send.test.ts`).

**Exact steps or command run after this patch:**

```
node scripts/run-vitest.mjs run src/gateway/server-methods/send.test.ts
```

**Before evidence (RED — guard not yet applied):**

```
 FAIL  |gateway-methods| ../../src/gateway/server-methods/send.test.ts > gateway send mirroring > gateway send reserved-target guard > rejects reserved send.to value current with INVALID_REQUEST
 FAIL  |gateway-methods| ../../src/gateway/server-methods/send.test.ts > gateway send mirroring > gateway send reserved-target guard > rejects reserved send.to value Current with INVALID_REQUEST
 FAIL  |gateway-methods| ../../src/gateway/server-methods/send.test.ts > gateway send mirroring > gateway send reserved-target guard > rejects reserved send.to value CURRENT with INVALID_REQUEST
 FAIL  |gateway-methods| ../../src/gateway/server-methods/send.test.ts > gateway send mirroring > gateway send reserved-target guard > rejects reserved send.to value self with INVALID_REQUEST
 FAIL  |gateway-methods| ../../src/gateway/server-methods/send.test.ts > gateway send mirroring > gateway send reserved-target guard > rejects reserved send.to value Self with INVALID_REQUEST
 FAIL  |gateway-methods| ../../src/gateway/server-methods/send.test.ts > gateway send mirroring > gateway send reserved-target guard > rejects reserved send.to value SELF with INVALID_REQUEST
 FAIL  |gateway-methods| ../../src/gateway/server-methods/send.test.ts > gateway send mirroring > gateway send reserved-target guard > rejects reserved send.to value this with INVALID_REQUEST
 FAIL  |gateway-methods| ../../src/gateway/server-methods/send.test.ts > gateway send mirroring > gateway send reserved-target guard > rejects reserved send.to value This with INVALID_REQUEST
 FAIL  |gateway-methods| ../../src/gateway/server-methods/send.test.ts > gateway send mirroring > gateway send reserved-target guard > rejects reserved send.to value THIS with INVALID_REQUEST
 FAIL  |gateway-methods| ../../src/gateway/server-methods/send.test.ts > gateway send mirroring > gateway send reserved-target guard > rejects reserved send.to value me with INVALID_REQUEST
 FAIL  |gateway-methods| ../../src/gateway/server-methods/send.test.ts > gateway send mirroring > gateway send reserved-target guard > rejects reserved send.to value Me with INVALID_REQUEST
 FAIL  |gateway-methods| ../../src/gateway/server-methods/send.test.ts > gateway send mirroring > gateway send reserved-target guard > rejects reserved send.to value ME with INVALID_REQUEST
AssertionError: expected true to be false // Object.is equality
- Expected
+ Received
- false
+ true
 ❯ ../../src/gateway/server-methods/send.test.ts:2541:25
 Test Files  2 failed (2)
      Tests  24 failed | 120 passed (144)
   Start at  20:44:00
   Duration  5.03s
[test] failed 1 Vitest shard in 12.61s
```

**Evidence after fix (GREEN):**

```
$ cd /tmp/oc-wt-91372 && corepack pnpm exec node scripts/run-vitest.mjs run src/gateway/server-methods/send.test.ts 2>&1 | tail -10
[test] starting test/vitest/vitest.gateway.config.ts

 RUN  v4.1.8 /private/tmp/oc-wt-91372

 Test Files  2 passed (2)
      Tests  144 passed (144)
   Start at  20:44:31
   Duration  2.56s (transform 621ms, setup 139ms, import 60ms, tests 1.76s, environment 0ms)

[test] passed 1 Vitest shard in 9.96s
```

**Observed result:** `to="current"` (and all 11 case variants + `self`/`this`/`me`) now return `INVALID_REQUEST` with message containing "reserved". Real targets such as `"telegram:C1234567890"` still reach `resolveOutboundTarget` — the guard does not fire.

**What was not tested:** The prefix form `"telegram:current"` (channel-prefixed target where "current" is a sub-field) is out of scope — no production incident matches that pattern. The reserved-word check operates on the full case-folded `to` string, so `"telegram:current"` passes through and is handled by the channel-specific resolver as before.

---

Allow edits by maintainers: yes

> AI-assisted: this fix was generated and verified by Claude Code (claude-sonnet-4-6). Logic reviewed for over-rejection against cron and agent-config `{mode:"current"}` paths — both confirmed unaffected.
