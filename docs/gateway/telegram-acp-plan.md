# Telegram ACP Plan

## Goal

Get Telegram ACP behavior into a state where we can say, with evidence:

1. one-shot Codex/Claude delegation works reliably from Telegram
2. we understand whether current behavior is one-shot relay or persistent thread binding
3. we know what Phase 2 should be for auto-thread + persistent Codex binding
4. tester-lane debugging is fast enough that we do not lose hours to bad visibility

## Current Reality

- The active tester worktree is `codex/acp-feature-fix`.
- The tester lane we validated is currently using the `Jarvis tester 2` bot.
- `Jarvis Email` and `Jarvis tester 2` were previously mixed up during testing because lane identity and bot identity were not printed clearly enough.
- A recurring launchd zombie from worktree `9779` repeatedly reintroduced Telegram `409 getUpdates` conflicts after reboot.
- The `tg-finance` lane previously had stale Codex OAuth state (`refresh_token_reused`), which caused fake ACP conclusions because Codex never actually started.

## What We Have Already Proved

### Proven

- One-shot ACP invocation can run Codex from Telegram and return a result to Telegram.
- The current tester flow can execute consecutive Codex requests from the same Telegram thread.
- Visibility in `scripts/telegram-live-preflight.sh` is better than before; startup waits are no longer completely silent.
- The direct tester lane for this worktree is the `Jarvis tester 2` bot, not `Jarvis Email`.

### Still Unclear

- Whether the current Telegram tester flow should be described as:
  - true persistent Codex thread ownership, or
  - parent-owned relay with session reuse behind the scenes
- Whether the maintainer-intended UX supports:
  - "start a new Telegram chat/topic with `run this in codex ...`"
  - automatic topic creation
  - persistent binding of that topic to Codex while the parent bot remains the relay

## Phase 1: Classify Current Behavior

### Question

When a user says `run this in codex ...` inside a Telegram thread, does OpenClaw:

1. create or reuse a persistent Codex ACP session bound to that thread, or
2. run Codex one-shot each time and relay the output back through the parent assistant?

### Evidence To Collect

- ACP/log lines for session reuse vs fresh child creation
- whether the same ACP session key is reused across follow-up Codex requests
- whether plain follow-up messages like `pwd` stay on Codex automatically or only work after explicit `run this in codex`

### Current User Observation

- `run this in codex "who am i"` returns `Output from Codex: ...`
- follow-up `pwd` also returns `Output from Codex: ...`
- plain follow-up `who are you?` returns from the main assistant
- `run this in codex what was my last message?` appears to trigger Codex again as a fresh run rather than act like a permanently switched thread

### Current Classification

Observed runtime behavior in the tester lane looks like **parent-owned relay with session reuse semantics**, not "thread permanently switched to Codex."

Evidence:

- `TESTER2_ACP_OK_01` and `TESTER2_ACP_OK_02` were both emitted through `[agent:nested]` log lines in `/tmp/openclaw/openclaw-2026-03-21.log`.
- `run this in codex "who am i"` and plain follow-up `pwd` both returned `Output from Codex: ...` replies in the same Telegram thread.
- Plain `who are you?` returned from the main assistant, not Codex.
- `run this in codex what was my last message?` again produced a nested Codex result relayed by the parent assistant.

Working interpretation:

- the main Telegram assistant still owns the thread
- Codex is being invoked and its output is being relayed back into that same thread
- some Codex context appears to be reused across follow-up turns
- but the thread is not hard-switched into a "Codex only" mode

## Phase 2: Compare With Maintainer Intent

### Goal

Look up how the original maintainer demoed Telegram + Codex ACP behavior:

- auto thread/topic creation from a DM
- `run this in codex ...` as the first message
- whether the resulting Telegram topic is persistently backed by Codex
- whether the main assistant remains the relay or the thread becomes "Codex-owned"

### Why This Matters

There are two valid products here:

1. **Parent-owned relay**
   - safer
   - keeps Jarvis in control
   - easier to fall back to the main assistant

2. **Persistent thread-bound Codex**
   - better for deep debugging on the go
   - stronger mental model for "this thread is Codex now"
   - more direct for repeated terminal-style work

We should not guess which one to optimize for.

### Current Read From Code And Docs

- ACP routing guidance explicitly prefers `thread: true` with `mode: "session"` for Telegram ACP requests.
- Telegram's adapter currently supports **current conversation placement**, not true child-thread placement.
- That means the codebase has logic for "bind ACP to this Telegram conversation" but not for "create a separate Telegram child conversation owned by Codex."
- The live tester behavior still shows parent relay semantics in logs, so intended path and observed path are not fully aligned yet.

### Observed vs Intended

- Intended path from code/docs:
  - persistent ACP session
  - bound to the current Telegram conversation
  - not a true child-thread Telegram placement
- Observed tester behavior:
  - replies are emitted through `[agent:nested]` parent relay logs
  - Codex output is returned inside the same Telegram thread
  - the parent assistant still answers some plain-language follow-ups itself

So the practical product behavior today is:

- same-thread Codex relay is working
- it feels semi-persistent from the user's point of view
- but it is not yet a clean "this thread is now fully Codex-owned" experience

## Phase 3: 80/20 Visibility Fixes

These are small, high-leverage improvements to stop future debugging waste:

1. print token fingerprint + resolved bot name at lane startup
2. print whether the lane is using repo `.env.local` or service env
3. make preflight inspect only fresh log lines from the current run
4. print the currently resolved Telegram bot identity explicitly

### Implementation Notes

- Startup logging should print:
  - current bot identity (`@username`, bot id when available)
  - token source (`env`, `config`, `tokenFile`)
  - token fingerprint
  - account name / account id
- Preflight should print:
  - `current_lane_bot=...`
  - `runtime_token_source=...`
  - `token_origin_hint=repo_env_local|service_env|...`
  - and should only scan fresh log lines from the current run when classifying conflicts

## Exit Criteria

We can close this track when all of the following are true:

- we have a written classification of current Telegram ACP behavior
- we have upstream/maintainer evidence for intended Phase 2 UX
- we have landed the 80/20 visibility fixes
- we have one clean E2E transcript for the current behavior
- we have a clear product recommendation:
  - keep relay-only
  - add persistent thread-bound mode
  - or support both intentionally
