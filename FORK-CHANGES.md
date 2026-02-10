# Fork Changes: davidrudduck/openclaw

Tracking all changes in our fork that are not yet in upstream `openclaw/openclaw:main`.
Use this to identify when upstream absorbs our fixes so we can drop the fork delta.

**Last synced with upstream:** 2026-02-10 (upstream commit `47f6bb414`)
**Our merge commit:** `3ed4d3bc9`

---

## Open Upstream PRs

| PR                                                        | Title                                            | Branch                              | Status |
| --------------------------------------------------------- | ------------------------------------------------ | ----------------------------------- | ------ |
| [#13185](https://github.com/openclaw/openclaw/pull/13185) | sanitize error responses to prevent info leakage | `fix/sanitize-error-responses`      | OPEN   |
| [#13184](https://github.com/openclaw/openclaw/pull/13184) | default standalone servers to loopback bind      | `fix/default-bind-loopback`         | OPEN   |
| [#13183](https://github.com/openclaw/openclaw/pull/13183) | use execFileSync to prevent shell injection      | `fix/execsync-to-execfilesync`      | OPEN   |
| [#12573](https://github.com/openclaw/openclaw/pull/12573) | normalize hook addresses to canonical format     | `fix/channel-id-hook-normalization` | OPEN   |
| [#12251](https://github.com/openclaw/openclaw/pull/12251) | timing-safe comparison for hook token auth       | `fix/hook-token-timing-safe`        | OPEN   |
| [#12172](https://github.com/openclaw/openclaw/pull/12172) | harden resolveUserPath and compact               | `fix/trim-bug-remaining-guards`     | OPEN   |
| [#11867](https://github.com/openclaw/openclaw/pull/11867) | wire message_sent hook — centralised             | `fix/wire-message-sent-hook-pr`     | OPEN   |
| [#11866](https://github.com/openclaw/openclaw/pull/11866) | guard .trim() on undefined in subagent           | `fix/subagent-trim-crash`           | OPEN   |

### Closed / Superseded PRs (for reference)

| PR                                                        | Superseded by | Reason                                  |
| --------------------------------------------------------- | ------------- | --------------------------------------- |
| [#12371](https://github.com/openclaw/openclaw/pull/12371) | #13185        | Branch deleted during fork maintenance  |
| [#12370](https://github.com/openclaw/openclaw/pull/12370) | #13184        | Branch deleted during fork maintenance  |
| [#12253](https://github.com/openclaw/openclaw/pull/12253) | #13183        | Branch deleted during fork maintenance  |
| [#12207](https://github.com/openclaw/openclaw/pull/12207) | #12251        | Duplicate; same branch, earlier version |
| [#11823](https://github.com/openclaw/openclaw/pull/11823) | #11867        | Replaced by centralised approach        |

---

## Change Groups

### 1. message_sent Hook (Feature)

**PRs:** [#11867](https://github.com/openclaw/openclaw/pull/11867), [#12573](https://github.com/openclaw/openclaw/pull/12573)

Fires a `message_sent` hook after successful outbound message delivery across all channels.
Includes canonical address normalization (`<source>:<method>:<id>` format).

| Commit      | Description                                                     |
| ----------- | --------------------------------------------------------------- |
| `ddc477e42` | Wire message_sent hook to deliverOutboundPayloads               |
| `76cb4d3f9` | Wire message_sent hook to Discord reply delivery path           |
| `e77d80d12` | Centralise message_sent hook in reply dispatcher                |
| `962524fc7` | Add tests for message_sent hook in reply dispatcher and deliver |
| `093b3ecc9` | Only report delivered payload text in message_sent hook         |
| `ef2f9464a` | Skip message_sent hook when hookContext is missing              |
| `a8fb56450` | Correct message_sent hook payload bugs flagged in review        |
| `fe9e62401` | Normalize hook addresses to canonical format (#6)               |
| `0f0a4ff8e` | Address CodeRabbit review feedback on message_sent hook PR (#7) |

**Files:**

- `src/auto-reply/reply/dispatch-from-config.ts` (+130 lines)
- `src/auto-reply/reply/dispatch-from-config.test.ts` (+261 lines)
- `src/auto-reply/reply/reply-dispatcher.ts` (+28 lines)
- `src/auto-reply/reply/reply-dispatcher.test.ts` (+133 lines)
- `src/infra/outbound/deliver.ts` (+39 lines)
- `src/infra/outbound/deliver.test.ts` (+55 lines)

**Upstream status:** Not yet merged. Track via upstream PRs or grep for `message_sent` in upstream commits.

---

### 2. .trim() Crash Guards (Bug Fix)

**PRs:** [#11866](https://github.com/openclaw/openclaw/pull/11866), [#12172](https://github.com/openclaw/openclaw/pull/12172)

Guards against `undefined.trim()` crashes in subagent system prompt building and workspace resolution.

| Commit      | Description                                                                |
| ----------- | -------------------------------------------------------------------------- |
| `85d2d02a2` | Guard file.path.trim() in buildAgentSystemPrompt (subagent crash)          |
| `c2f7a0ba5` | Guard file.path.trim() in buildAgentSystemPrompt (subagent crash)          |
| `f6341a221` | Guard .trim() calls on potentially-undefined values in subagent path       |
| `f1a54b5f0` | Guard .trim() calls on potentially-undefined values in subagent path       |
| `ecf7e0165` | Use consistent fallback for missing file.path in subagent prompt           |
| `54067c07d` | Harden resolveUserPath and compact against undefined workspaceDir (#10176) |
| `84f372523` | Pass effectiveWorkspace to createAgentSession for sandbox cwd consistency  |

**Files:**

- `src/agents/system-prompt.ts` — `(file.path ?? "").trim()` at line 555
- `src/agents/subagent-announce.ts`
- `src/agents/subagent-registry.ts`
- `src/agents/pi-embedded-runner/compact.ts` — uses `resolveRunWorkspaceDir`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/utils.ts` — `resolveUserPath` input guard
- `src/utils.test.ts`

**Upstream status:** Not yet merged. The root cause (`resolveUserPath` called with undefined) may be fixed differently upstream. Check if upstream adds null guards to these paths.

---

### 3. Security Hardening (Bug Fixes)

**PRs:** [#12251](https://github.com/openclaw/openclaw/pull/12251), [#13183](https://github.com/openclaw/openclaw/pull/13183), [#13184](https://github.com/openclaw/openclaw/pull/13184), [#13185](https://github.com/openclaw/openclaw/pull/13185)

| Commit      | Description                                                        |
| ----------- | ------------------------------------------------------------------ |
| `d7c008a3c` | Timing-safe comparison for hook token authentication               |
| `16eb281c4` | Buffer-length comparison and timing-safe check for bluebubbles     |
| `0dcbf4d24` | Use execFileSync instead of execSync to avoid shell injection (#3) |
| `f112ee2f5` | Default standalone servers to loopback bind (#4)                   |
| `c456041ef` | Sanitize error responses to prevent information leakage (#5)       |

**Files:**

- `src/gateway/server-http.ts` — `timingSafeEqual` for token auth
- `extensions/bluebubbles/src/monitor.ts` — timing-safe token check
- `src/daemon/program-args.ts` — `execFileSync` instead of `execSync`
- `src/gateway/openai-http.ts` — error sanitization
- `src/gateway/openresponses-http.ts` — error sanitization
- `src/gateway/session-utils.ts` — error sanitization
- `src/gateway/server-methods/agent.ts` — error sanitization
- `src/gateway/tools-invoke-http.ts` — error sanitization
- `src/canvas-host/server.ts` — error sanitization
- `src/telegram/webhook.ts` — error sanitization

**Upstream status:** Not yet merged. These are straightforward security improvements — upstream may adopt them independently or via PR.

---

### 4. Housekeeping

| Commit      | Description                                                      |
| ----------- | ---------------------------------------------------------------- |
| `7bde3aab1` | gitignore .omc/ and remove tracked oh-my-claudecode session data |
| `e633051f4` | Remove workspace files from PR branch                            |

**Files:**

- `.gitignore`

**Upstream status:** `.omc/` is fork-specific tooling; may never need upstream merge.

---

## Quick Check: Is Our Change Still Needed?

Run after each upstream sync:

```bash
# 1. List all our non-merge commits not in upstream
git log --oneline --no-merges upstream/main...HEAD --right-only

# 2. Check specific guard still exists
grep -n '(file.path ?? "").trim()' src/agents/system-prompt.ts

# 3. Check message_sent hook still exists
grep -rn 'message_sent' src/auto-reply/reply/reply-dispatcher.ts src/infra/outbound/deliver.ts

# 4. Check security fixes
grep -n 'timingSafeEqual' src/gateway/server-http.ts
grep -n 'execFileSync' src/daemon/program-args.ts

# 5. Check open PR status
gh pr list --repo openclaw/openclaw --author davidrudduck --state open
```

## Total Fork Delta

- **22 non-merge commits**
- **24 files changed** (+696 lines, -32 lines)
- **4 change groups**: message_sent hook, .trim() guards, security hardening, housekeeping
- **8 open PRs** upstream
