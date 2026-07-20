# Microsoft Ecosystem Issues & PRs Tracker

> **Purpose:** Living checklist for maintainers to track all open Microsoft-related issues and PRs (Teams, Windows, WSL, Azure, M365/SharePoint).
>
> **How to use:**
>
> - Mark items resolved by editing this PR body and changing `[ ]` to `[x]`
> - Claim items by adding your GitHub handle to the `Assignee` column
> - Priority guide: **P0** = crash/blocker/security, **P1** = significant bug/regression, **P2** = minor bug/enhancement, **P3** = nice-to-have/stale
> - Items marked _(stale)_ have been flagged by the stale bot due to inactivity
>
> **Last updated:** 2026-07-20 (post-purge audit: refreshed from currently open GitHub issues/PRs and rebuilt from PR #49126 format)

---

## Summary

| Category                  | Issues | PRs    | Total   | Closed | Remaining |
| ------------------------- | ------ | ------ | ------- | ------ | --------- |
| MS Teams (channel plugin) | 15     | 44     | 59      | 0      | 59        |
| Windows platform          | 52     | 36     | 88      | 0      | 88        |
| WSL                       | 4      | 0      | 4       | 0      | 4         |
| Azure                     | 10     | 6      | 16      | 0      | 16        |
| SharePoint / M365         | 0      | 1      | 1       | 0      | 1         |
| **Total**                 | **81** | **87** | **168** | **0**  | **168**   |

---

## 1. MS Teams Channel Plugin — Issues

### Bugs / Crashes

| Resolved? | Priority | #       | Title                                                                                                                                                       | Labels                                                                                                                                                               | Assignee |
| --------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [ ]       | P0       | #105322 | Teams: local multi-user Workspaces sharing with exact tab RBAC                                                                                              | `P3` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-security-review` `impact:security` +2 |          |
| [ ]       | P1       | #106566 | [Bug] False-Positive Channel Health Failure for MS Teams on Expired Delegated Token                                                                         | `no-stale` `P2` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:source-repro` `impact:auth-provider` +2                                       |          |
| [ ]       | P1       | #101049 | [Bug]: msteams plugin npm install can leave an empty dependency tree — plugin loads, provider dies silently, Microsoft sees delivery errors                 | `clawsweeper:needs-live-repro` `impact:message-loss` `P0` `issue-rating: 🐚 platinum hermit` `maturity:stable` `impact:ux-release-blocker`                           |          |
| [ ]       | P1       | #67177  | [msteams] Inbound file attachments silently fail in DMs — file.download.info downloadUrl not rewritten to Graph shares endpoint                             | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:message-loss` `issue-rating: 🦞 diamond lobster`                    |          |
| [ ]       | P2       | #104521 | Native approval buttons for Feishu, Microsoft Teams, and Mattermost                                                                                         | `P2` `clawsweeper:source-repro` `issue-rating: 🦞 diamond lobster` `maturity:stable` `impact:ux-friction`                                                            |          |
| [ ]       | P2       | #104381 | [Bug]: MSTeams provider-prefixed explicit target IDs miss resolver gate                                                                                     | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:message-loss` `issue-rating: 🦞 diamond lobster`                    |          |
| [ ]       | P2       | #102376 | [Bug]: MS Teams inbound mentions, quoted replies, and forwards are not normalized for agent text                                                            | `bug` `maintainer` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` +2                                                       |          |
| [ ]       | P2       | #102274 | msteams: streaming merges post-tool text segment into the preamble bubble (onPartialReply slices at a stale offset — #76262 regressed #56071)               | `no-stale` `P1` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:source-repro` `impact:message-loss` +1                                        |          |
| [ ]       | P2       | #95737  | [Bug]: msteams channel allowlist never works — messages always dropped regardless of configuration due to "groupAllowFrom" problem                          | `bug` `bug:behavior` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` +2                                                     |          |
| [ ]       | P2       | #94939  | [Bug]: 6.x state migration leaves channel conversation-store SQLite empty (0 bytes) — orphans references, breaks proactive (Bot Framework) sends (MS Teams) | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:linked-pr-open` `clawsweeper:needs-live-repro` `impact:data-loss` `impact:message-loss` +1                             |          |
| [ ]       | P2       | #91723  | msteams: streaming double-posts replies over 4000 chars after SDK rebase (#76262 regressed #59297)                                                          | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:message-loss` `issue-rating: 🦞 diamond lobster`                    |          |
| [ ]       | P2       | #88836  | [Bug]: msteams messages with attachments misthreaded                                                                                                        | `bug` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:message-loss` +1                                              |          |

### Feature Requests

| Resolved? | Priority | #      | Title                                                                                         | Labels                                                                                                                                                                  | Assignee |
| --------- | -------- | ------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [ ]       | P2       | #99939 | [Feature]: MSTeams - Support raw Adaptive Card JSON in message tool for richer approval cards | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` +2 |          |
| [ ]       | P2       | #93288 | feat(msteams): per-call topLevel override on send action for proactive new channel threads    | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:message-loss` `issue-rating: 🦞 diamond lobster`                       |          |
| [ ]       | P2       | #81084 | [Feature]: MSTeams channel-bound agents need opt-out from per-thread sessions                 | `stale` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +3                    |          |

---

## 2. MS Teams Channel Plugin — PRs

| Resolved? | Priority | #       | Title                                                                                                                 | Size | Assignee     |
| --------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------- | ---- | ------------ |
| [ ]       | P0       | #111527 | refactor(config): config-surface reduction tranche 3 — product consolidations (review request)                        | XL   | @steipete    |
| [ ]       | P0       | #103780 | EXPERIMENTAL: authorization policy prototype — DO NOT LAND                                                            | XL   | @steipete    |
| [ ]       | P0       | #100858 | feat(message): add universal pagination contract with cursor support for MSTeams                                      | M    |              |
| [ ]       | P0       | #100350 | fix(msteams): handle bot removal and uninstallation to mark sessions stale                                            | M    |              |
| [ ]       | P0       | #94978  | feat(msteams): Microsoft Teams voice (CVI) + video + chat + governance                                                | XL   |              |
| [ ]       | P0       | #92603  | fix(cron): summarize shell failures directly                                                                          | XL   |              |
| [ ]       | P0       | #91438  | feat(voice-call): Microsoft Teams provider — CVI voice/video calls                                                    | XL   |              |
| [ ]       | P0       | #87169  | Support separate Teams Graph tenant                                                                                   | S    |              |
| [ ]       | P0       | #77784  | Add Teams delegated auth for plugin tools                                                                             | XL   |              |
| [ ]       | P0       | #55828  | feat(msteams): add native plugin interactivity parity                                                                 | XL   |              |
| [ ]       | P1       | #111638 | fix(msteams): reject malformed OAuth token envelopes [AI-assisted]                                                    | S    |              |
| [ ]       | P1       | #106923 | fix(msteams): keep delegated auth healthy when an expired token can auto-refresh                                      | XS   |              |
| [ ]       | P1       | #104692 | feat(msteams): support multiple bot accounts                                                                          | XL   |              |
| [ ]       | P1       | #92591  | feat(msteams): respond to channel messages by keyword without an @mention                                             | S    |              |
| [ ]       | P1       | #89944  | Idr msteams adaptive card tables                                                                                      | M    |              |
| [ ]       | P1       | #82354  | fix(msteams): emit message:sent hook on reply delivery                                                                | M    |              |
| [ ]       | P1       | #79185  | fix(tts/xiaomi): support Token Plan TTS endpoint                                                                      | S    |              |
| [ ]       | P1       | #77921  | feat(inworld): default to inworld-tts-2 (Realtime TTS-2)                                                              | XS   |              |
| [ ]       | P1       | #59986  | refactor(plugins): add lane-oriented channel interface                                                                | XL   |              |
| [ ]       | P2       | #111437 | feat(talk): add realtime live translation                                                                             |      |              |
| [ ]       | P2       | #111317 | fix(msteams): token refresh hangs past deadline when DNS preflight stalls                                             | S    |              |
| [ ]       | P2       | #110230 | docs: document local TTS on macOS, Linux, and Windows                                                                 | XS   |              |
| [ ]       | P2       | #109970 | fix(msteams): release failed Graph collection bodies                                                                  | S    |              |
| [ ]       | P2       | #109864 | fix(msteams): bound federated certificate file reads                                                                  | S    |              |
| [ ]       | P2       | #109112 | fix(msteams): ignore blank certificate settings                                                                       | S    |              |
| [ ]       | P2       | #109030 | fix(msteams): bound remote media saves with header and idle timeouts                                                  | S    |              |
| [ ]       | P2       | #107171 | fix: prevent duplicate Teams broker retry turns                                                                       | L    |              |
| [ ]       | P2       | #107164 | fix: Teams Graph and media work with RFC2544 proxy DNS                                                                | S    |              |
| [ ]       | P2       | #106461 | fix(msteams): remove unused attachment helper                                                                         | XS   |              |
| [ ]       | P2       | #104691 | fix(msteams): proactive sends fail after conversation migration                                                       | S    |              |
| [ ]       | P2       | #104690 | fix(msteams): reset sessions on app removal lifecycle                                                                 | XL   | @steipete    |
| [ ]       | P2       | #102379 | fix(msteams): normalize inbound mentions and forwards                                                                 | L    | @galiniliev  |
| [ ]       | P2       | #101995 | fix(msteams): use fetchGraphAbsoluteUrl for replies nextLink                                                          | XS   |              |
| [ ]       | P2       | #100906 | feat(signal): add setup wizard                                                                                        | XL   | @jesse-merhi |
| [ ]       | P2       | #100166 | fix(msteams): paginate thread replies to include newest context (#98870)                                              | M    |              |
| [ ]       | P2       | #98972  | fix: block channel reads outside allowlists [AI]                                                                      | XL   | @joshavant   |
| [ ]       | P2       | #95867  | fix(msteams): sanitize internal tool-trace lines from outbound text (#90684)                                          | XS   |              |
| [ ]       | P2       | #94348  | fix(msteams): keep attachment replies in channel threads                                                              | S    |              |
| [ ]       | P2       | #93292  | feat(msteams): per-call topLevel override on send action for proactive new channel threads                            | S    |              |
| [ ]       | P2       | #91729  | fix(msteams): trim streamed prefix in long-reply fallback to stop >4000-char double-post (regressed #59297 in #76262) | M    |              |
| [ ]       | P2       | #89152  | feat(hooks): add agent turn end hook                                                                                  | XL   |              |
| [ ]       | P2       | #88103  | Update Teams CLI install command                                                                                      | XS   |              |
| [ ]       | P2       | #83988  | fix(tts): defer text settlement for final-mode TTS to eliminate churn (#83511)                                        | XL   |              |
| [ ]       | P2       | #78839  | [codex] Add Teams member-info action gate                                                                             | S    |              |

---

## 3. Windows Platform — Issues

### Bugs / Crashes

| Resolved? | Priority | #       | Title                                                                                                                                                                                   | Labels                                                                                                                                                                              | Assignee    |
| --------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| [ ]       | P0       | #105667 | [Bug] Incorrect Sandbox Bind Mount Parsing for Windows Relative Drive-Letter Paths                                                                                                      | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-security-review` `clawsweeper:source-repro` +2       |             |
| [ ]       | P0       | #102755 | [Bug]: The project won't start on Windows and WSL.                                                                                                                                      | `bug` `bug:behavior` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +6                                                 |             |
| [ ]       | P0       | #98470  | [Bug]: openclaw doctor misses Windows cloud-synced state dirs                                                                                                                           | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:session-state` `impact:security` +2                                                |             |
| [ ]       | P0       | #89527  | 建议：为国内 Windows 用户提供一键安装器方案                                                                                                                                             | `P3` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-security-review` +2    |             |
| [ ]       | P0       | #83890  | Windows restart script builds ProcessStartInfo.Arguments via string concatenation without quoting embedded double-quotes                                                                | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-security-review` `clawsweeper:needs-live-repro` +2          |             |
| [ ]       | P1       | #111476 | Windows: Telegram voice-note STT + exec-approvals writer fail silently with EPERM on fsync/rename (no retry, no user feedback)                                                          | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `impact:session-state` `impact:message-loss` +1                         |             |
| [ ]       | P1       | #110789 | Windows: taskkill without /F leaks npx-spawned child processes (MCP servers, sub-agents)                                                                                                | `P1` `clawsweeper:needs-live-repro` `impact:crash-loop` `issue-rating: 🐚 platinum hermit`                                                                                          |             |
| [ ]       | P1       | #109436 | Model fallback selection ignores candidate context windows, causing overflow/compaction storms on mid-turn failover                                                                     | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `impact:session-state` +2                    |             |
| [ ]       | P1       | #105528 | exec/read tools silently return empty output on Windows (v2026.6.x regression)                                                                                                          | `bug` `docs`                                                                                                                                                                        |             |
| [ ]       | P1       | #102286 | Windows: multiple gateway-down failure modes (kill-and-rebind restart loop, config-edit no-relaunch, browser launch crash, blocking pricing fetches)                                    | `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` `impact:session-state` `impact:crash-loop` +4 |             |
| [ ]       | P1       | #100075 | [[Bug]: Windows Companion gives "Auth did not match" and openclaw onboard redirects to MyClaw.ai                                                                                        | `bug` `stale` `regression` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-info` +4                                                            |             |
| [ ]       | P1       | #93081  | [Bug]: Ctrl+C not working in Windows install on foreground                                                                                                                              | `bug` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-info` `impact:crash-loop` +1                                                        |             |
| [ ]       | P1       | #91675  | fetch failed / UND_ERR_SOCKET on Windows WSL when connecting to Google Gemini                                                                                                           | `bug` `bug:crash` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` +4                                                           |             |
| [ ]       | P1       | #91144  | [Bug]: Windows native CLI gateway Scheduled Task does not stay running; foreground window worksWindows native CLI gateway Scheduled Task does not stay running; foreground window works | `bug` `bug:behavior` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` +2                                                                    |             |
| [ ]       | P1       | #90548  | macOS: per-port lsof port-health polling can saturate launchservicesd and trigger a WindowServer watchdog reboot                                                                        | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` +2         |             |
| [ ]       | P1       | #90158  | Gateway self-restart on Windows fails silently when schtasks /Run cannot relaunch the scheduled task                                                                                    | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:source-repro` `impact:session-state` `impact:message-loss` +2                                   |             |
| [ ]       | P1       | #88373  | Windows post-onboarding provider switch path is not discoverable                                                                                                                        | `P3` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:auth-provider` `issue-rating: 🦞 diamond lobster`                                  |             |
| [ ]       | P1       | #88372  | Windows provider switch leaves stale model/provider config and session cache                                                                                                            | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` +3         |             |
| [ ]       | P1       | #87136  | compaction: absolute token thresholds break when switching models with different context windows                                                                                        | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` +3              |             |
| [ ]       | P1       | #86987  | [Bug]: [Regression] Gateway 5.18+ shows empty Caps for all node versions on Windows/Docker                                                                                              | `bug` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +3                                  |             |
| [ ]       | P1       | #86031  | [Bug]: Windows gateway listens but local health/status time out after Telegram polling stall (v2026.5.20)                                                                               | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` `impact:session-state` +4                |             |
| [ ]       | P1       | #84213  | [Bug]: openclaw completion -s zsh hangs on native Windows (no WSL)                                                                                                                      | `bug` `stale` `regression` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` +5                                                                                |             |
| [ ]       | P1       | #84203  | [Bug]: Windows — models.authStatus cold latency 10-24s per CLI session (2026.5.18 + Codex 0.131.0)                                                                                      | `bug` `stale` `regression` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` +5                                                                                |             |
| [ ]       | P1       | #84001  | Windows: openclaw status / status --json hangs in 2026.5.18 while status --all succeeds                                                                                                 | `stale` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` `impact:crash-loop` +1                                                |             |
| [ ]       | P1       | #80416  | [Bug] core-plugin-tools ~3.5s overhead on every embedded run persists after #75520 fix — Windows + Node 24 + isolated cron jobs                                                         | `stale` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` +2                               |             |
| [ ]       | P1       | #80344  | [Bug]: Discord voice /vc join fails on Windows with AggregateError + gateway heartbeat timeout / event loop starvation                                                                  | `bug` `stale` `bug:crash` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` +4                                                                                 |             |
| [ ]       | P1       | #77443  | [Bug]: WhatsApp event loop blocked (eventLoopDelayMaxMs=12088ms) on first inbound message — 2026.5.3-1 Windows                                                                          | `bug` `stale` `regression` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` +6                                                                                |             |
| [ ]       | P1       | #74378  | [Bug]: OpenClaw CLI commands remain alive as node.exe processes after execution on Windows                                                                                              | `bug` `regression` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `impact:crash-loop` +1                                                                    |             |
| [ ]       | P1       | #71699  | [Bug]: Gateway hard-crashes with 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) on Windows during Mattermost streaming reply; auto-respawn frequently wedges                                  | `stale` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` +5                               |             |
| [ ]       | P1       | #63491  | [Bug]: Windows Scheduled Task gateway restart/health becomes inconsistent after ready                                                                                                   | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` `impact:session-state` +3                       | @vincentkoc |
| [ ]       | P2       | #111683 | [Bug]: Windows Tray regenerates device identity on every reboot, requiring re-pairing each time                                                                                         | `P2` `impact:other`                                                                                                                                                                 |             |
| [ ]       | P2       | #111620 | [Bug]: Windows file tools misresolve POSIX drive paths                                                                                                                                  | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:linked-pr-open` `clawsweeper:needs-live-repro` `issue-rating: 🐚 platinum hermit` `impact:other` +2                                   |             |
| [ ]       | P2       | #111595 | [Bug]: Equivalent Windows cwd spellings split catalog project groups                                                                                                                    | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:linked-pr-open` `clawsweeper:needs-live-repro` `issue-rating: 🐚 platinum hermit` `impact:ux-friction`                                |             |
| [ ]       | P2       | #111567 | SYSTEM_RUN_DENIED: approval required on Windows node despite correct exec-approvals.json (socket initialized with missing file)                                                         | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `issue-rating: 🦪 silver shellfish` `impact:other`                                                           |             |
| [ ]       | P2       | #110757 | [Bug]: Windows Tray chat code blocks have no copy button                                                                                                                                | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `issue-rating: 🦪 silver shellfish` `impact:ux-friction`                                                     |             |
| [ ]       | P2       | #108802 | exec tool renders PowerShell output as "see in attachment" on Windows when output contains binary BOM                                                                                   | `P2` `clawsweeper:needs-info` `issue-rating: 🦐 gold shrimp` `impact:ux-friction`                                                                                                   |             |
| [ ]       | P2       | #106203 | Remote Windows node is connected and system.which works, but Codex/WebChat exposes no node_exec surface                                                                                 | `P2` `issue-rating: 🦪 silver shellfish` `impact:ux-friction`                                                                                                                       |             |
| [ ]       | P2       | #105696 | [Bug] Liveness Verification Defect (process.kill signal 0) on Windows                                                                                                                   | `P2` `impact:message-loss` `issue-rating: 🦪 silver shellfish`                                                                                                                      |             |
| [ ]       | P2       | #100955 | fix(plugins): document-extractors API fails to resolve relative paths on Windows                                                                                                        | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-info` `issue-rating: 🦪 silver shellfish` `impact:other`                                  |             |
| [ ]       | P2       | #99502  | Windows: openclaw gateway start opens visible terminal window (Scheduled Task LogonType=InteractiveToken)                                                                               | `stale` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-info` `issue-rating: 🦐 gold shrimp` +2                                           |             |
| [ ]       | P2       | #95072  | fix: Windows /restart falls back to in-process restart without changing PID                                                                                                             | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `issue-rating: 🦞 diamond lobster` +1                 |             |
| [ ]       | P2       | #80650  | [Bug]: [Bug] openclaw backup create 在Windows上失败（退出代码255）                                                                                                                      | `bug` `stale` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +3                                                        |             |
| [ ]       | P2       | #77730  | [Bug]: file-transfer plugin nodeHostCommands not advertised by Windows node host on live handshake (2026.5.3-1)                                                                         | `stale` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` `issue-rating: 🐚 platinum hermit` +2                                 |             |
| [ ]       | P2       | #58139  | [Bug]: memory-lancedb plugin fails with Windows Docker bind mount                                                                                                                       | `bug` `stale` `bug:behavior` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:linked-pr-open` +3                                                                                       |             |
| [ ]       | P2       | #44291  | Add native PowerShell smoke coverage for contributor commands                                                                                                                           | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `issue-rating: 🦞 diamond lobster` +1        |             |
| [ ]       | P2       | #40694  | Browser-opened temporary tabs/windows should close automatically after task completion                                                                                                  | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `impact:session-state` +2                    |             |

### Feature Requests

| Resolved? | Priority | #      | Title                                                                                                                              | Labels                                                                                                                                                                           | Assignee |
| --------- | -------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [ ]       | P0       | #89223 | [Bug]: SecretRef file provider broken on Windows 11 26200 — icacls /sid unsupported, preflight validator ignores allowInsecurePath | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-security-review` +4 |          |
| [ ]       | P0       | #72595 | [Feature]: Feishu channel needs per-channel proxy bypass for mixed Windows proxy setups                                            | `enhancement` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-security-review` +5                 |          |
| [ ]       | P0       | #75    | Linux/Windows Clawdbot Apps                                                                                                        | `enhancement` `help wanted` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +4                                       |          |
| [ ]       | P2       | #97800 | [Feature]: Console-free windows dashboard autostart (also without duplicate gateway launch)                                        | `enhancement` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` +3                      |          |
| [ ]       | P2       | #18985 | [Feature]: Supports Windows 11 MSYS environment and Fishshell.                                                                     | `enhancement` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` +3                          |          |
| [ ]       | P2       | #7057  | Flaky tests on Windows/WSL: timeouts and ENOENT in pi-tools workspace-paths & safe-bins                                            | `enhancement` `P3` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:linked-pr-open` `issue-rating: 🦪 silver shellfish` +1                         |          |

---

## 4. Windows Platform — PRs

| Resolved? | Priority | #       | Title                                                                                 | Size | Assignee |
| --------- | -------- | ------- | ------------------------------------------------------------------------------------- | ---- | -------- |
| [ ]       | P0       | #108073 | fix(infra): scope Windows path realpath caches                                        | M    |          |
| [ ]       | P0       | #101698 | fix(file-transfer): expand Windows-style tilde policy globs                           | XS   |          |
| [ ]       | P0       | #96164  | fix(exec): resolve PowerShell 7 via where.exe on Windows                              | S    |          |
| [ ]       | P1       | #111716 | fix(process): resolve Windows commands when env aliases are blank                     | S    |          |
| [ ]       | P1       | #111596 | fix(ui): keep Windows catalog sessions in one project group                           | S    |          |
| [ ]       | P1       | #111523 | fix(json-parse): exclude code-context tails from Windows-path heuristic (#93139)      | S    |          |
| [ ]       | P1       | #110253 | fix(perf): gateway startup benchmark reports n/a CPU/RSS on Windows                   | M    |          |
| [ ]       | P1       | #97436  | test: make workshop symlink tests compatible with Windows                             | XS   |          |
| [ ]       | P1       | #94514  | docs: add Windows pnpm fallback for Corepack EPERM                                    | XS   |          |
| [ ]       | P1       | #69059  | fix: retry sqlite-vec load without .dll suffix on Windows                             | S    |          |
| [ ]       | P2       | #111814 | [AI] fix(update-cli): warn+continue on Windows schtasks access-denied                 | S    |          |
| [ ]       | P2       | #111624 | fix(tools): read POSIX drive paths on Windows                                         | S    |          |
| [ ]       | P2       | #111500 | fix(shell): resolve pwsh.exe/.cmd/.bat on PATH for Windows shell discovery            | XS   |          |
| [ ]       | P2       | #111257 | fix(diffs): find Windows browsers when install roots are blank                        | S    |          |
| [ ]       | P2       | #111256 | fix(browser): detect Windows browsers when install roots are blank                    | XS   |          |
| [ ]       | P2       | #110947 | [codex] Add WhatsApp group listen windows                                             | M    |          |
| [ ]       | P2       | #110877 | fix(scripts): use direct-run helper for Windows guards                                | S    |          |
| [ ]       | P2       | #110198 | fix(process): Windows exec/read empty output when detached spawn leaks                | S    |          |
| [ ]       | P2       | #109431 | fix(anthropic): complete transcript reverse-scan windows across short reads           | S    |          |
| [ ]       | P2       | #109163 | fix: PowerShell exec output with BOM renders as text                                  | M    |          |
| [ ]       | P2       | #108242 | fix(gateway): fill bounded transcript windows across short reads                      | S    |          |
| [ ]       | P2       | #107656 | refactor(channels)!: close the streaming flat-key and intro-hint deprecation windows  | L    |          |
| [ ]       | P2       | #104234 | fix(process): bound Windows exec timeout cleanup                                      | M    |          |
| [ ]       | P2       | #104053 | fix(shell): use PowerShell CLI args for custom pwsh/powershell shell paths on Windows | XS   |          |
| [ ]       | P2       | #98471  | fix: warn on windows cloud synced state dirs                                          | M    |          |
| [ ]       | P2       | #97439  | test: make marketplace symlink tests compatible with Windows                          | XS   |          |
| [ ]       | P2       | #97438  | test: make refresh symlink tests compatible with Windows                              | XS   |          |
| [ ]       | P2       | #97437  | test: make workspace-load symlink tests compatible with Windows                       | S    |          |
| [ ]       | P2       | #96839  | fix: add windowsHide to all spawn calls to prevent visible console windows on Windows | XS   |          |
| [ ]       | P2       | #95982  | fix(json-parse): exclude code-context tails from Windows-path heuristic (#93139)      | S    |          |
| [ ]       | P2       | #95095  | fix(supervisor): probe schtasks directly when env vars are missing                    | S    |          |
| [ ]       | P2       | #93299  | fix(daemon): prove Windows schtasks launch without foreground listener [AI]           | S    |          |
| [ ]       | P2       | #91610  | ci(windows): add native PowerShell smoke coverage for contributor commands            | XS   |          |
| [ ]       | P2       | #90273  | test: make fs-safe hardlink tests compatible with Windows                             | XS   |          |
| [ ]       | P2       | #90271  | test: make fs-safe symlink tests compatible with Windows                              | S    |          |
| [ ]       | P2       | #84280  | fix: handle SIGUSR1 restart on Windows where the signal is unsupported                | S    |          |

---

## 5. WSL (Windows Subsystem for Linux) — Issues

### Bugs / Crashes

| Resolved? | Priority | #       | Title                                                                                                                                           | Labels                                                                                                                                                | Assignee |
| --------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [ ]       | P0       | #80336  | [Bug]: placeholder.openclaw.cloud unreachable on WSL2 with custom gateway port                                                                  | `bug` `stale` `bug:behavior` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` +7                                                |          |
| [ ]       | P1       | #84610  | [Bug]: Gateway loops with SIGTERM every ~90s after upgrade 2026.4.23→2026.5.18 (WSL2). Inbound msg received but cli watchdog kills mid-response | `stale` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` +4 |          |
| [ ]       | P2       | #105306 | [Bug]: browser snapshot fails with connectOverCDP socket hang up when proxy.enabled is true (WSL/Linux)                                         | `bug`                                                                                                                                                 |          |
| [ ]       | P2       | #90953  | [Bug]: installing error message "WSL version output did not include a parseable WSL version"                                                    | `bug` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` +3       |          |

### Feature Requests

_No currently open items found._

---

## 6. WSL (Windows Subsystem for Linux) — PRs

_No currently open items found._

---

## 7. Azure (Provider / Infrastructure) — Issues

### Bugs / Crashes

| Resolved? | Priority | #       | Title                                                                                                                        | Labels                                                                                                                                                               | Assignee |
| --------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [ ]       | P1       | #95894  | Plugin installs crash Express 4.x routes: core npm-shrinkwrap pins path-to-regexp@8.x but no central override covers plugins | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `impact:crash-loop` +1        |          |
| [ ]       | P1       | #80926  | Azure OpenAI Responses stalls before first event when memory tools are exposed                                               | `maintainer` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` +3           |          |
| [ ]       | P2       | #111386 | Azure OpenAI embedding provider fails — api-version not forwarded as URL query parameter                                     |                                                                                                                                                                      |          |
| [ ]       | P2       | #103067 | Centralize chat-session naming; define subagent session lifetime & cross-channel persistence                                 | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` `impact:session-state` +3 |          |
| [ ]       | P2       | #48788  | feat: centralized filename encoding utility for multi-encoding Content-Disposition handling                                  | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `impact:data-loss` +1         |          |

### Feature Requests

| Resolved? | Priority | #       | Title                                                                                               | Labels                                                                                                                                                               | Assignee |
| --------- | -------- | ------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [ ]       | P0       | #87325  | Support Azure Foundry GPT Realtime Talk via gateway relay                                           | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-security-review` `impact:security` +2 |          |
| [ ]       | P1       | #106477 | [Feature]: Wanting to Add Concentrate AI Compatibility to the Routing Integrations                  | `enhancement` `P3` `impact:auth-provider`                                                                                                                            |          |
| [ ]       | P1       | #102907 | Azure OpenAI Responses throws 400 when prompt_cache_key is sent to endpoints that do not support it | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` `impact:auth-provider` +1 |          |
| [ ]       | P1       | #71058  | [Feature]: Support for multiple Azure/Teams bots on a single Openclaw Gateway                       | `enhancement` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `impact:auth-provider` +1                             |          |
| [ ]       | P2       | #90842  | [Feature]: Document and/or centralize the per-event cfg re-resolve contract for channel plugins     | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `impact:message-loss` +1      |          |

---

## 8. Azure (Provider / Infrastructure) — PRs

| Resolved? | Priority | #       | Title                                                                          | Size | Assignee |
| --------- | -------- | ------- | ------------------------------------------------------------------------------ | ---- | -------- |
| [ ]       | P0       | #70922  | refactor(whatsapp): centralize account policy                                  | L    |          |
| [ ]       | P2       | #111813 | fix: Azure OpenAI memory indexing fails for custom providers                   | S    |          |
| [ ]       | P2       | #110299 | docs(providers): add Azure OpenAI setup page and directory entry               | XS   |          |
| [ ]       | P2       | #107070 | refactor(whatsapp): centralize inbound turn admission and history finalization | M    |          |
| [ ]       | P2       | #98259  | fix(openai): enable prompt cache keys for Azure                                | M    |          |
| [ ]       | P2       | #96000  | fix(session-lock): allow reentrant acquire from inner transcript writers       | XS   |          |

---

## 9. Microsoft 365 / SharePoint — Issues

### Bugs / Crashes

_No currently open items found._

### Feature Requests

_No currently open items found._

---

## 10. Microsoft 365 / SharePoint — PRs

| Resolved? | Priority | #       | Title                                                                              | Size | Assignee |
| --------- | -------- | ------- | ---------------------------------------------------------------------------------- | ---- | -------- |
| [ ]       | P0       | #111658 | feat(msgraph-mail-wake): Microsoft Graph mailbox change-notification wake provider | XL   |          |

---

## Appendix: P0 Blockers (Start Here)

| Category                  | Type  | Priority | #       | Title                                                                                                                              |
| ------------------------- | ----- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| MS Teams (channel plugin) | issue | P0       | #105322 | Teams: local multi-user Workspaces sharing with exact tab RBAC                                                                     |
| MS Teams (channel plugin) | pr    | P0       | #111527 | refactor(config): config-surface reduction tranche 3 — product consolidations (review request)                                     |
| MS Teams (channel plugin) | pr    | P0       | #103780 | EXPERIMENTAL: authorization policy prototype — DO NOT LAND                                                                         |
| MS Teams (channel plugin) | pr    | P0       | #100858 | feat(message): add universal pagination contract with cursor support for MSTeams                                                   |
| MS Teams (channel plugin) | pr    | P0       | #100350 | fix(msteams): handle bot removal and uninstallation to mark sessions stale                                                         |
| MS Teams (channel plugin) | pr    | P0       | #94978  | feat(msteams): Microsoft Teams voice (CVI) + video + chat + governance                                                             |
| MS Teams (channel plugin) | pr    | P0       | #92603  | fix(cron): summarize shell failures directly                                                                                       |
| MS Teams (channel plugin) | pr    | P0       | #91438  | feat(voice-call): Microsoft Teams provider — CVI voice/video calls                                                                 |
| MS Teams (channel plugin) | pr    | P0       | #87169  | Support separate Teams Graph tenant                                                                                                |
| MS Teams (channel plugin) | pr    | P0       | #77784  | Add Teams delegated auth for plugin tools                                                                                          |
| MS Teams (channel plugin) | pr    | P0       | #55828  | feat(msteams): add native plugin interactivity parity                                                                              |
| Windows platform          | issue | P0       | #105667 | [Bug] Incorrect Sandbox Bind Mount Parsing for Windows Relative Drive-Letter Paths                                                 |
| Windows platform          | issue | P0       | #102755 | [Bug]: The project won't start on Windows and WSL.                                                                                 |
| Windows platform          | issue | P0       | #98470  | [Bug]: openclaw doctor misses Windows cloud-synced state dirs                                                                      |
| Windows platform          | issue | P0       | #89527  | 建议：为国内 Windows 用户提供一键安装器方案                                                                                        |
| Windows platform          | issue | P0       | #89223  | [Bug]: SecretRef file provider broken on Windows 11 26200 — icacls /sid unsupported, preflight validator ignores allowInsecurePath |
| Windows platform          | issue | P0       | #83890  | Windows restart script builds ProcessStartInfo.Arguments via string concatenation without quoting embedded double-quotes           |
| Windows platform          | issue | P0       | #72595  | [Feature]: Feishu channel needs per-channel proxy bypass for mixed Windows proxy setups                                            |
| Windows platform          | issue | P0       | #75     | Linux/Windows Clawdbot Apps                                                                                                        |
| Windows platform          | pr    | P0       | #108073 | fix(infra): scope Windows path realpath caches                                                                                     |
| Windows platform          | pr    | P0       | #101698 | fix(file-transfer): expand Windows-style tilde policy globs                                                                        |
| Windows platform          | pr    | P0       | #96164  | fix(exec): resolve PowerShell 7 via where.exe on Windows                                                                           |
| WSL                       | issue | P0       | #80336  | [Bug]: placeholder.openclaw.cloud unreachable on WSL2 with custom gateway port                                                     |
| Azure                     | issue | P0       | #87325  | Support Azure Foundry GPT Realtime Talk via gateway relay                                                                          |
| Azure                     | pr    | P0       | #70922  | refactor(whatsapp): centralize account policy                                                                                      |
| SharePoint / M365         | pr    | P0       | #111658 | feat(msgraph-mail-wake): Microsoft Graph mailbox change-notification wake provider                                                 |

## Appendix: High-Priority Bugs / Regressions

| Category                  | Type  | Priority | #       | Title                                                                                                                                                                                   |
| ------------------------- | ----- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MS Teams (channel plugin) | issue | P1       | #106566 | [Bug] False-Positive Channel Health Failure for MS Teams on Expired Delegated Token                                                                                                     |
| MS Teams (channel plugin) | issue | P1       | #101049 | [Bug]: msteams plugin npm install can leave an empty dependency tree — plugin loads, provider dies silently, Microsoft sees delivery errors                                             |
| MS Teams (channel plugin) | issue | P1       | #67177  | [msteams] Inbound file attachments silently fail in DMs — file.download.info downloadUrl not rewritten to Graph shares endpoint                                                         |
| MS Teams (channel plugin) | pr    | P1       | #111638 | fix(msteams): reject malformed OAuth token envelopes [AI-assisted]                                                                                                                      |
| MS Teams (channel plugin) | pr    | P1       | #106923 | fix(msteams): keep delegated auth healthy when an expired token can auto-refresh                                                                                                        |
| MS Teams (channel plugin) | pr    | P1       | #104692 | feat(msteams): support multiple bot accounts                                                                                                                                            |
| MS Teams (channel plugin) | pr    | P1       | #92591  | feat(msteams): respond to channel messages by keyword without an @mention                                                                                                               |
| MS Teams (channel plugin) | pr    | P1       | #89944  | Idr msteams adaptive card tables                                                                                                                                                        |
| MS Teams (channel plugin) | pr    | P1       | #82354  | fix(msteams): emit message:sent hook on reply delivery                                                                                                                                  |
| MS Teams (channel plugin) | pr    | P1       | #79185  | fix(tts/xiaomi): support Token Plan TTS endpoint                                                                                                                                        |
| MS Teams (channel plugin) | pr    | P1       | #77921  | feat(inworld): default to inworld-tts-2 (Realtime TTS-2)                                                                                                                                |
| MS Teams (channel plugin) | pr    | P1       | #59986  | refactor(plugins): add lane-oriented channel interface                                                                                                                                  |
| Windows platform          | issue | P1       | #111476 | Windows: Telegram voice-note STT + exec-approvals writer fail silently with EPERM on fsync/rename (no retry, no user feedback)                                                          |
| Windows platform          | issue | P1       | #110789 | Windows: taskkill without /F leaks npx-spawned child processes (MCP servers, sub-agents)                                                                                                |
| Windows platform          | issue | P1       | #109436 | Model fallback selection ignores candidate context windows, causing overflow/compaction storms on mid-turn failover                                                                     |
| Windows platform          | issue | P1       | #105528 | exec/read tools silently return empty output on Windows (v2026.6.x regression)                                                                                                          |
| Windows platform          | issue | P1       | #102286 | Windows: multiple gateway-down failure modes (kill-and-rebind restart loop, config-edit no-relaunch, browser launch crash, blocking pricing fetches)                                    |
| Windows platform          | issue | P1       | #100075 | [[Bug]: Windows Companion gives "Auth did not match" and openclaw onboard redirects to MyClaw.ai                                                                                        |
| Windows platform          | issue | P1       | #93081  | [Bug]: Ctrl+C not working in Windows install on foreground                                                                                                                              |
| Windows platform          | issue | P1       | #91675  | fetch failed / UND_ERR_SOCKET on Windows WSL when connecting to Google Gemini                                                                                                           |
| Windows platform          | issue | P1       | #91144  | [Bug]: Windows native CLI gateway Scheduled Task does not stay running; foreground window worksWindows native CLI gateway Scheduled Task does not stay running; foreground window works |
| Windows platform          | issue | P1       | #90548  | macOS: per-port lsof port-health polling can saturate launchservicesd and trigger a WindowServer watchdog reboot                                                                        |
| Windows platform          | issue | P1       | #90158  | Gateway self-restart on Windows fails silently when schtasks /Run cannot relaunch the scheduled task                                                                                    |
| Windows platform          | issue | P1       | #88373  | Windows post-onboarding provider switch path is not discoverable                                                                                                                        |
| Windows platform          | issue | P1       | #88372  | Windows provider switch leaves stale model/provider config and session cache                                                                                                            |
| Windows platform          | issue | P1       | #87136  | compaction: absolute token thresholds break when switching models with different context windows                                                                                        |
| Windows platform          | issue | P1       | #86987  | [Bug]: [Regression] Gateway 5.18+ shows empty Caps for all node versions on Windows/Docker                                                                                              |
| Windows platform          | issue | P1       | #86031  | [Bug]: Windows gateway listens but local health/status time out after Telegram polling stall (v2026.5.20)                                                                               |
| Windows platform          | issue | P1       | #84213  | [Bug]: openclaw completion -s zsh hangs on native Windows (no WSL)                                                                                                                      |
| Windows platform          | issue | P1       | #84203  | [Bug]: Windows — models.authStatus cold latency 10-24s per CLI session (2026.5.18 + Codex 0.131.0)                                                                                      |
| Windows platform          | issue | P1       | #84001  | Windows: openclaw status / status --json hangs in 2026.5.18 while status --all succeeds                                                                                                 |
| Windows platform          | issue | P1       | #80416  | [Bug] core-plugin-tools ~3.5s overhead on every embedded run persists after #75520 fix — Windows + Node 24 + isolated cron jobs                                                         |
| Windows platform          | issue | P1       | #80344  | [Bug]: Discord voice /vc join fails on Windows with AggregateError + gateway heartbeat timeout / event loop starvation                                                                  |
| Windows platform          | issue | P1       | #77443  | [Bug]: WhatsApp event loop blocked (eventLoopDelayMaxMs=12088ms) on first inbound message — 2026.5.3-1 Windows                                                                          |
| Windows platform          | issue | P1       | #74378  | [Bug]: OpenClaw CLI commands remain alive as node.exe processes after execution on Windows                                                                                              |
| Windows platform          | issue | P1       | #71699  | [Bug]: Gateway hard-crashes with 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) on Windows during Mattermost streaming reply; auto-respawn frequently wedges                                  |
| Windows platform          | issue | P1       | #63491  | [Bug]: Windows Scheduled Task gateway restart/health becomes inconsistent after ready                                                                                                   |
| Windows platform          | pr    | P1       | #111716 | fix(process): resolve Windows commands when env aliases are blank                                                                                                                       |
| Windows platform          | pr    | P1       | #111596 | fix(ui): keep Windows catalog sessions in one project group                                                                                                                             |
| Windows platform          | pr    | P1       | #111523 | fix(json-parse): exclude code-context tails from Windows-path heuristic (#93139)                                                                                                        |
| Windows platform          | pr    | P1       | #110253 | fix(perf): gateway startup benchmark reports n/a CPU/RSS on Windows                                                                                                                     |
| Windows platform          | pr    | P1       | #97436  | test: make workshop symlink tests compatible with Windows                                                                                                                               |
| Windows platform          | pr    | P1       | #94514  | docs: add Windows pnpm fallback for Corepack EPERM                                                                                                                                      |
| Windows platform          | pr    | P1       | #69059  | fix: retry sqlite-vec load without .dll suffix on Windows                                                                                                                               |
| WSL                       | issue | P1       | #84610  | [Bug]: Gateway loops with SIGTERM every ~90s after upgrade 2026.4.23→2026.5.18 (WSL2). Inbound msg received but cli watchdog kills mid-response                                         |
| Azure                     | issue | P1       | #106477 | [Feature]: Wanting to Add Concentrate AI Compatibility to the Routing Integrations                                                                                                      |
| Azure                     | issue | P1       | #102907 | Azure OpenAI Responses throws 400 when prompt_cache_key is sent to endpoints that do not support it                                                                                     |
| Azure                     | issue | P1       | #95894  | Plugin installs crash Express 4.x routes: core npm-shrinkwrap pins path-to-regexp@8.x but no central override covers plugins                                                            |
| Azure                     | issue | P1       | #80926  | Azure OpenAI Responses stalls before first event when memory tools are exposed                                                                                                          |
| Azure                     | issue | P1       | #71058  | [Feature]: Support for multiple Azure/Teams bots on a single Openclaw Gateway                                                                                                           |

## Appendix: Stale Items (Consider Closing)

| Category                  | Type  | Priority | #       | Title                                                                                                                                                  |
| ------------------------- | ----- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MS Teams (channel plugin) | issue | P2       | #81084  | [Feature]: MSTeams channel-bound agents need opt-out from per-thread sessions                                                                          |
| MS Teams (channel plugin) | pr    | P0       | #91438  | feat(voice-call): Microsoft Teams provider — CVI voice/video calls                                                                                     |
| MS Teams (channel plugin) | pr    | P0       | #87169  | Support separate Teams Graph tenant                                                                                                                    |
| MS Teams (channel plugin) | pr    | P1       | #89944  | Idr msteams adaptive card tables                                                                                                                       |
| MS Teams (channel plugin) | pr    | P2       | #89152  | feat(hooks): add agent turn end hook                                                                                                                   |
| MS Teams (channel plugin) | pr    | P2       | #88103  | Update Teams CLI install command                                                                                                                       |
| Windows platform          | issue | P1       | #100075 | [[Bug]: Windows Companion gives "Auth did not match" and openclaw onboard redirects to MyClaw.ai                                                       |
| Windows platform          | issue | P1       | #84213  | [Bug]: openclaw completion -s zsh hangs on native Windows (no WSL)                                                                                     |
| Windows platform          | issue | P1       | #84203  | [Bug]: Windows — models.authStatus cold latency 10-24s per CLI session (2026.5.18 + Codex 0.131.0)                                                     |
| Windows platform          | issue | P1       | #84001  | Windows: openclaw status / status --json hangs in 2026.5.18 while status --all succeeds                                                                |
| Windows platform          | issue | P1       | #80416  | [Bug] core-plugin-tools ~3.5s overhead on every embedded run persists after #75520 fix — Windows + Node 24 + isolated cron jobs                        |
| Windows platform          | issue | P1       | #80344  | [Bug]: Discord voice /vc join fails on Windows with AggregateError + gateway heartbeat timeout / event loop starvation                                 |
| Windows platform          | issue | P1       | #77443  | [Bug]: WhatsApp event loop blocked (eventLoopDelayMaxMs=12088ms) on first inbound message — 2026.5.3-1 Windows                                         |
| Windows platform          | issue | P1       | #71699  | [Bug]: Gateway hard-crashes with 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) on Windows during Mattermost streaming reply; auto-respawn frequently wedges |
| Windows platform          | issue | P2       | #99502  | Windows: openclaw gateway start opens visible terminal window (Scheduled Task LogonType=InteractiveToken)                                              |
| Windows platform          | issue | P2       | #80650  | [Bug]: [Bug] openclaw backup create 在Windows上失败（退出代码255）                                                                                     |
| Windows platform          | issue | P2       | #77730  | [Bug]: file-transfer plugin nodeHostCommands not advertised by Windows node host on live handshake (2026.5.3-1)                                        |
| Windows platform          | issue | P2       | #58139  | [Bug]: memory-lancedb plugin fails with Windows Docker bind mount                                                                                      |
| Windows platform          | pr    | P0       | #96164  | fix(exec): resolve PowerShell 7 via where.exe on Windows                                                                                               |
| Windows platform          | pr    | P1       | #97436  | test: make workshop symlink tests compatible with Windows                                                                                              |
| Windows platform          | pr    | P2       | #98471  | fix: warn on windows cloud synced state dirs                                                                                                           |
| Windows platform          | pr    | P2       | #97439  | test: make marketplace symlink tests compatible with Windows                                                                                           |
| Windows platform          | pr    | P2       | #97438  | test: make refresh symlink tests compatible with Windows                                                                                               |
| Windows platform          | pr    | P2       | #97437  | test: make workspace-load symlink tests compatible with Windows                                                                                        |
| Windows platform          | pr    | P2       | #96839  | fix: add windowsHide to all spawn calls to prevent visible console windows on Windows                                                                  |
| Windows platform          | pr    | P2       | #91610  | ci(windows): add native PowerShell smoke coverage for contributor commands                                                                             |
| Windows platform          | pr    | P2       | #90273  | test: make fs-safe hardlink tests compatible with Windows                                                                                              |
| Windows platform          | pr    | P2       | #90271  | test: make fs-safe symlink tests compatible with Windows                                                                                               |
| WSL                       | issue | P0       | #80336  | [Bug]: placeholder.openclaw.cloud unreachable on WSL2 with custom gateway port                                                                         |
| WSL                       | issue | P1       | #84610  | [Bug]: Gateway loops with SIGTERM every ~90s after upgrade 2026.4.23→2026.5.18 (WSL2). Inbound msg received but cli watchdog kills mid-response        |
| Azure                     | pr    | P2       | #96000  | fix(session-lock): allow reentrant acquire from inner transcript writers                                                                               |

## Audit Notes

- Rebuilt from the format of PR #49126 after the issue/PR purge.
- Source set is currently open GitHub issues and PRs from `openclaw/openclaw`; closed counts are intentionally reset to `0` for this refreshed tracker.
- Included title/label matches for `msteams`, Microsoft Teams, Windows, WSL, Azure, Entra/AAD, MSAL, managed identity, DefaultAzureCredential, Microsoft Graph, SharePoint, OneDrive, and Microsoft 365.
- Kept broad multi-channel PRs when they carry `channel: msteams`, because those can still affect the Microsoft surface area.
- Generated with `node scripts/generate-microsoft-tracker.mjs` so the tracker and PR body can be refreshed after future triage passes.
