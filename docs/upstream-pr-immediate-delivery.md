# PR: fix(subagents): trigger immediate parent turn after direct delivery

**Branch:** `pr/subagent-immediate-delivery`  
**Target:** `upstream/main`  
**Status:** Ready to open  
**Closes (partially):** #22099, #27317  
**Related:** PR #25437 (closed — see context below)

---

## Pre-Open Checklist

- [ ] Push branch to fork: `git push origin pr/subagent-immediate-delivery`
- [ ] Open PR against `openclaw/openclaw:main`
- [ ] Link to #22099 and #27317 in body
- [ ] Reference PR #25437 closure context — explain what 4258a3307 addressed and what gap remains
- [ ] Mention `hadDirectSendRoute` guard as the key correctness improvement over naive "path === direct" check

---

## PR Description

````markdown
## Problem

When a sub-agent completes and its result is sent directly to the user's
channel (method:send), the requester session (Atlas) never sees it unless the
user sends another message. The result sits unprocessed until the next turn.

Related: #22099, #27317

## Context: PR #25437

PR #25437 attempted a similar fix but was closed Feb 26 as superseded by
commit `4258a3307`, which consolidated the unified announce delivery dispatch.
That commit improved announce routing but doesn't address this specific case:
after a successful direct channel send, the requester session still doesn't
get woken up to process the result.

## Approach

After a direct-channel delivery confirms success, fire a lightweight
`method:agent` call into the requester session with `SILENT_REPLY_TOKEN`
so Atlas processes the result without generating a duplicate user-visible
message.

## Key correctness guard: `hadDirectSendRoute`

`sendSubagentAnnounceDirectly` returns `path: "direct"` for two different
cases:

- Real channel send via `method:send` (what we want to trigger on)
- Internal requester-session injection via `method:agent` (the fallback when
  no direct route exists — this already wakes the requester)

A naive `delivery.path === "direct"` check would fire the silent trigger even
when the internal fallback was used, causing a duplicate turn.

Fix: check `hadDirectSendRoute = Boolean(completionResolution.origin?.channel) && Boolean(completionResolution.origin?.to)` before evaluating. A real send route always has both fields populated; the internal method:agent fallback doesn't.

## Full guard set

```typescript
const isSilentTriggerCandidate =
  delivery.delivered &&
  delivery.path === "direct" &&
  hadDirectSendRoute && // real channel send, not internal fallback
  !requesterIsSubagent && // don't wake sub-agent requesters
  expectsCompletionMessage && // run-mode spawns only
  announceType !== "cron job" && // cron announces are self-contained
  params.spawnMode !== "session" && // session-mode uses bound-thread routing
  findings.trim().length > 0 &&
  findings !== "(no output)";
```
````

Plus an active-sibling check — trigger only fires when no other descendant
runs are still active (avoids waking the requester mid-batch).

## Testing

67 existing announce tests pass. 5 test assertions updated to reflect that
`agentSpy` is called once (the silent trigger) after direct delivery — those
tests were previously asserting `not.toHaveBeenCalled()` which matched the
old behavior where no trigger was fired.

```

---

## Notes

- The `hadDirectSendRoute` guard is the most important correctness detail — worth highlighting in the PR description and any review discussion.
- If maintainers want to expand the trigger to non-direct paths, that's their call — our guard is deliberately conservative.
- The active-sibling check (defaults to 1 / conservative) prevents waking the requester while parallel sub-agents are still running. This is a judgment call — maintainers may want to adjust the threshold.
- PR #25437's approach was similar but lacked the `hadDirectSendRoute` guard. Mention this as a specific improvement if the comparison comes up.
```
