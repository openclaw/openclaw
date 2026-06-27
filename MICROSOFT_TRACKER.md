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
> **Last updated:** 2026-06-27 (post-purge audit: refreshed from currently open GitHub issues/PRs and rebuilt from PR #49126 format)

---

## Summary

| Category                  | Issues | PRs    | Total   | Closed | Remaining |
| ------------------------- | ------ | ------ | ------- | ------ | --------- |
| MS Teams (channel plugin) | 11     | 47     | 58      | 0      | 58        |
| Windows platform          | 51     | 40     | 91      | 0      | 91        |
| WSL                       | 9      | 1      | 10      | 0      | 10        |
| Azure                     | 8      | 4      | 12      | 0      | 12        |
| SharePoint / M365         | 0      | 0      | 0       | 0      | 0         |
| **Total**                 | **79** | **92** | **171** | **0**  | **171**   |

---

## 1. MS Teams Channel Plugin — Issues

### Bugs / Crashes

| Resolved? | Priority | #      | Title                                                                                                                                                       | Labels                                                                                                                                                                           | Assignee |
| --------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [ ]       | P0       | #92452 | msteams: ClawHub install can never pass the 6.x keyed-store trust gate (official catalog is npmSpec-only) — channel crash-loops with no actionable error    | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-security-review` +4 |          |
| [ ]       | P1       | #67177 | [msteams] Inbound file attachments silently fail in DMs — file.download.info downloadUrl not rewritten to Graph shares endpoint                             | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:message-loss` `issue-rating: 🦞 diamond lobster`                                |          |
| [ ]       | P2       | #95737 | [Bug]: msteams channel allowlist never works — messages always dropped regardless of configuration due to "groupAllowFrom" problem                          | `bug` `bug:behavior` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` +2                                                                 |          |
| [ ]       | P2       | #94939 | [Bug]: 6.x state migration leaves channel conversation-store SQLite empty (0 bytes) — orphans references, breaks proactive (Bot Framework) sends (MS Teams) | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` `impact:data-loss` `impact:message-loss` +1                                |          |
| [ ]       | P2       | #91723 | msteams: streaming double-posts replies over 4000 chars after SDK rebase (#76262 regressed #59297)                                                          | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:message-loss` `issue-rating: 🦞 diamond lobster`                                |          |
| [ ]       | P2       | #89594 | [Bug]: In msteams channel messages, OpenClaw can't access inbound attachments                                                                               | `bug` `bug:behavior` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` +3                                                         |          |
| [ ]       | P2       | #88836 | [Bug]: msteams messages with attachments misthreaded                                                                                                        | `bug` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:message-loss` +1                                                          |          |
| [ ]       | P2       | #42099 | fix(plugins): false-positive duplicate plugin ID warning on gateway start (msteams)                                                                         | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-product-decision` `clawsweeper:linked-pr-open` `clawsweeper:needs-live-repro` `issue-rating: 🐚 platinum hermit` +1          |          |

### Feature Requests

| Resolved? | Priority | #      | Title                                                                                      | Labels                                                                                                                                                                           | Assignee |
| --------- | -------- | ------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [ ]       | P2       | #93288 | feat(msteams): per-call topLevel override on send action for proactive new channel threads | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:message-loss` `issue-rating: 🦞 diamond lobster`                                |          |
| [ ]       | P2       | #91856 | msteams: support Copilot-only streaming without enabling Teams DM streaming                | `P3` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` `issue-rating: 🐚 platinum hermit` +1 |          |
| [ ]       | P2       | #81084 | [Feature]: MSTeams channel-bound agents need opt-out from per-thread sessions              | `stale` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +3                             |          |

---

## 2. MS Teams Channel Plugin — PRs

| Resolved? | Priority | #      | Title                                                                                                                 | Size | Assignee               |
| --------- | -------- | ------ | --------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------- |
| [ ]       | P0       | #95764 | fix(msteams): allow groupAllowFrom to match conversation IDs                                                          | S    |                        |
| [ ]       | P0       | #94978 | feat(msteams): Microsoft Teams voice (CVI) + video + chat + governance                                                | XL   |                        |
| [ ]       | P0       | #93342 | pipeline: normalized provider→channel stream grammar (core)                                                           | XL   |                        |
| [ ]       | P0       | #92725 | External reranker                                                                                                     | XL   |                        |
| [ ]       | P0       | #92603 | fix(cron): summarize shell failures directly                                                                          | XL   |                        |
| [ ]       | P0       | #91722 | Refactor HTTP egress around external proxy enforcement                                                                | XL   |                        |
| [ ]       | P0       | #91438 | feat(voice-call): Microsoft Teams provider — CVI voice/video calls                                                    | XL   |                        |
| [ ]       | P0       | #91069 | Feat/mordiem document reader skill                                                                                    | XL   |                        |
| [ ]       | P0       | #89796 | IDR-msteams-aad-sender-identity: feat(msteams): add AAD sender identi…                                                | M    |                        |
| [ ]       | P0       | #87169 | Support separate Teams Graph tenant                                                                                   | S    |                        |
| [ ]       | P0       | #81402 | refactor: move runtime state to SQLite                                                                                | XL   |                        |
| [ ]       | P0       | #77784 | Add Teams delegated auth for plugin tools                                                                             | XL   |                        |
| [ ]       | P0       | #70990 | feat(plugins): add model failover and terminal failure hooks                                                          | XL   |                        |
| [ ]       | P0       | #55828 | feat(msteams): add native plugin interactivity parity                                                                 | XL   |                        |
| [ ]       | P1       | #94300 | fix(gateway): deliver OAuth authorization URLs to non-terminal clients                                                | L    |                        |
| [ ]       | P1       | #92591 | feat(msteams): respond to channel messages by keyword without an @mention                                             | S    |                        |
| [ ]       | P1       | #91644 | feat(gateway): add OpenAI-compatible /v1/audio/speech endpoint                                                        | L    |                        |
| [ ]       | P1       | #90622 | fix(ports): batch macOS lsof listener inspection to one spawn per cycle                                               | XL   |                        |
| [ ]       | P1       | #89944 | Idr msteams adaptive card tables                                                                                      | M    |                        |
| [ ]       | P1       | #88845 | Require signed beta desktop distribution                                                                              | XL   |                        |
| [ ]       | P1       | #82354 | fix(msteams): emit message:sent hook on reply delivery                                                                | M    |                        |
| [ ]       | P1       | #79185 | fix(tts/xiaomi): support Token Plan TTS endpoint                                                                      | S    |                        |
| [ ]       | P1       | #77921 | feat(inworld): default to inworld-tts-2 (Realtime TTS-2)                                                              | XS   |                        |
| [ ]       | P1       | #75043 | Add provider-aware automatic TTS emotion mapping                                                                      | XL   |                        |
| [ ]       | P1       | #59986 | refactor(plugins): add lane-oriented channel interface                                                                | XL   |                        |
| [ ]       | P2       | #96648 | Fix MSTeams card actions with durable receive before ACK                                                              | L    |                        |
| [ ]       | P2       | #96620 | fix(feishu,browser,msteams,azure-speech,bedrock-mantle,googlechat,huggingface,perplexity): bound JSON response reads  | XS   |                        |
| [ ]       | P2       | #96578 | fix(msteams): truncate reflection prompt on a UTF-16 boundary                                                         | XS   |                        |
| [ ]       | P2       | #96571 | fix(msteams): escape markup in mention display names                                                                  | XS   |                        |
| [ ]       | P2       | #96569 | fix(msteams): keep truncated parent context text well-formed                                                          | XS   |                        |
| [ ]       | P2       | #96215 | fix: cover cron setup watchdog timeout retries                                                                        | XL   |                        |
| [ ]       | P2       | #95867 | fix(msteams): sanitize internal tool-trace lines from outbound text (#90684)                                          | XS   |                        |
| [ ]       | P2       | #94348 | fix(msteams): keep attachment replies in channel threads                                                              | S    |                        |
| [ ]       | P2       | #93846 | fix(msteams): add per-call topLevel override on send action (fixes #93288)                                            | S    |                        |
| [ ]       | P2       | #93292 | feat(msteams): per-call topLevel override on send action for proactive new channel threads                            | S    |                        |
| [ ]       | P2       | #91729 | fix(msteams): trim streamed prefix in long-reply fallback to stop >4000-char double-post (regressed #59297 in #76262) | M    |                        |
| [ ]       | P2       | #90738 | fix(msteams): read file attachments on Teams channel messages (team GUID + channel fallback + thread-reply URL)       | S    |                        |
| [ ]       | P2       | #89154 | feat(hooks): add ACP turn transcript save hook                                                                        | XL   |                        |
| [ ]       | P2       | #89152 | feat(hooks): add agent turn end hook                                                                                  | XL   |                        |
| [ ]       | P2       | #88103 | Update Teams CLI install command                                                                                      | XS   |                        |
| [ ]       | P2       | #87304 | fix(update): fail closed on managed plugin pin conflicts                                                              | XL   | @vincentkoc, @steipete |
| [ ]       | P2       | #85845 | fix(msteams): route file.download.info links via graph shares                                                         | XS   | @vincentkoc            |
| [ ]       | P2       | #85478 | fix(slack): soften benign search no-result progress                                                                   | L    | @vincentkoc            |
| [ ]       | P2       | #84560 | feat(cli): support --dm-policy and --dm-allowlist in channels add                                                     |      |                        |
| [ ]       | P2       | #83988 | fix(tts): defer text settlement for final-mode TTS to eliminate churn (#83511)                                        | XL   |                        |
| [ ]       | P2       | #78839 | [codex] Add Teams member-info action gate                                                                             | S    |                        |
| [ ]       | P2       | #46303 | fix: drain inbound debounce buffer and followup queues before SIGUSR1 reload                                          | XL   |                        |

---

## 3. Windows Platform — Issues

### Bugs / Crashes

| Resolved? | Priority | #      | Title                                                                                                                                                                                   | Labels                                                                                                                                                                           | Assignee    |
| --------- | -------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| [ ]       | P0       | #89527 | 建议：为国内 Windows 用户提供一键安装器方案                                                                                                                                             | `P3` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-security-review` +2 |             |
| [ ]       | P0       | #83890 | Windows restart script builds ProcessStartInfo.Arguments via string concatenation without quoting embedded double-quotes                                                                | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-security-review` `clawsweeper:needs-live-repro` `impact:security` +1                   |             |
| [ ]       | P1       | #96835 | [Bug]: exec tool on Windows (v2026.6.10) pops visible cmd/PowerShell window for every command — regression from v2026.6.8                                                               | `bug` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-info` `issue-rating: 🦪 silver shellfish` +1                                     |             |
| [ ]       | P1       | #93081 | [Bug]: Ctrl+C not working in Windows install on foreground                                                                                                                              | `bug` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-info` `impact:crash-loop` +1                                                     |             |
| [ ]       | P1       | #92054 | [Bug]: Windows 11 - Claude CLI provider fails with spawn claude ENOENT                                                                                                                  | `bug` `regression` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` +2                                                                   |             |
| [ ]       | P1       | #91675 | fetch failed / UND_ERR_SOCKET on Windows WSL when connecting to Google Gemini                                                                                                           | `bug` `bug:crash` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` +4                                                        |             |
| [ ]       | P1       | #91489 | Windows: spawning claude via child_process fails (ENOENT/EINVAL) due to missing .cmd handling                                                                                           | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:auth-provider` `issue-rating: 🦞 diamond lobster`                               |             |
| [ ]       | P1       | #91144 | [Bug]: Windows native CLI gateway Scheduled Task does not stay running; foreground window worksWindows native CLI gateway Scheduled Task does not stay running; foreground window works | `bug` `bug:behavior` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` +2                                                                 |             |
| [ ]       | P1       | #90548 | macOS: per-port lsof port-health polling can saturate launchservicesd and trigger a WindowServer watchdog reboot                                                                        | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` +2      |             |
| [ ]       | P1       | #90158 | Gateway self-restart on Windows fails silently when schtasks /Run cannot relaunch the scheduled task                                                                                    | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:source-repro` `impact:session-state` `impact:message-loss` +2                                |             |
| [ ]       | P1       | #88373 | Windows post-onboarding provider switch path is not discoverable                                                                                                                        | `P3` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:auth-provider` `issue-rating: 🦞 diamond lobster`                               |             |
| [ ]       | P1       | #88372 | Windows provider switch leaves stale model/provider config and session cache                                                                                                            | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` +3      |             |
| [ ]       | P1       | #88371 | Windows QuickStart defaults first chat to paid Anthropic model without credit warning                                                                                                   | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` `impact:auth-provider` +1             |             |
| [ ]       | P1       | #87993 | [Bug]: Windows — openclaw update 期间 Scheduled Task PT3M 重复触发器重新拉起 gateway 导致竞态                                                                                           | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:crash-loop` `issue-rating: 🦞 diamond lobster`                                  | @vincentkoc |
| [ ]       | P1       | #87156 | [Bug]: Windows doctor update leaves Startup-folder gateway fallback stale and does not install Scheduled Task                                                                           | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:crash-loop` `issue-rating: 🦞 diamond lobster`                                  | @vincentkoc |
| [ ]       | P1       | #87136 | compaction: absolute token thresholds break when switching models with different context windows                                                                                        | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` +3           |             |
| [ ]       | P1       | #86987 | [Bug]: [Regression] Gateway 5.18+ shows empty Caps for all node versions on Windows/Docker                                                                                              | `bug` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +3                               |             |
| [ ]       | P1       | #86031 | [Bug]: Windows gateway listens but local health/status time out after Telegram polling stall (v2026.5.20)                                                                               | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `impact:session-state` `impact:message-loss` +2                      |             |
| [ ]       | P1       | #85268 | [Bug]: [Windows] exec spawn: all commands hang with no output (stdio pipe deadlock)                                                                                                     | `bug` `bug:crash` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `impact:crash-loop` +1                                                                  |             |
| [ ]       | P1       | #84600 | Bug: Windows heartbeat cmd window not hidden - 'findstr /I /C:"Running"' stays visible                                                                                                  | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:crash-loop` `issue-rating: 🦞 diamond lobster`                                  |             |
| [ ]       | P1       | #84213 | [Bug]: openclaw completion -s zsh hangs on native Windows (no WSL)                                                                                                                      | `bug` `regression` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` +2                                                      |             |
| [ ]       | P1       | #84203 | [Bug]: Windows — models.authStatus cold latency 10-24s per CLI session (2026.5.18 + Codex 0.131.0)                                                                                      | `bug` `regression` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` +4                                                       |             |
| [ ]       | P1       | #84001 | Windows: openclaw status / status --json hangs in 2026.5.18 while status --all succeeds                                                                                                 | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` `impact:crash-loop` `issue-rating: 🐚 platinum hermit`                     |             |
| [ ]       | P1       | #83277 | WhatsApp channel: "web login provider is not available" on Windows despite wacli installed and authenticated                                                                            | `bug` `bug:behavior` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` +2                                                                 |             |
| [ ]       | P1       | #80416 | [Bug] core-plugin-tools ~3.5s overhead on every embedded run persists after #75520 fix — Windows + Node 24 + isolated cron jobs                                                         | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` `impact:crash-loop` +1                |             |
| [ ]       | P1       | #80344 | [Bug]: Discord voice /vc join fails on Windows with AggregateError + gateway heartbeat timeout / event loop starvation                                                                  | `bug` `bug:crash` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` +2                                                       |             |
| [ ]       | P1       | #79437 | Prebuilt `node-llama-cpp` Windows binaries crash (0xC0000005) on Intel Alder Lake-N (N95) — qmd LLM half unusable                                                                       | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` `impact:session-state` +2             |             |
| [ ]       | P1       | #77443 | [Bug]: WhatsApp event loop blocked (eventLoopDelayMaxMs=12088ms) on first inbound message — 2026.5.3-1 Windows                                                                          | `bug` `regression` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +4                                                |             |
| [ ]       | P1       | #74378 | [Bug]: OpenClaw CLI commands remain alive as node.exe processes after execution on Windows                                                                                              | `bug` `regression` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:linked-pr-open` `clawsweeper:needs-live-repro` +2                                                               |             |
| [ ]       | P1       | #71865 | Auth login blocked by size-drop guard when openclaw.json was created by PowerShell (verbose/BOM format)                                                                                 | `stale` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:data-loss` +2                                                           |             |
| [ ]       | P1       | #71699 | [Bug]: Gateway hard-crashes with 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) on Windows during Mattermost streaming reply; auto-respawn frequently wedges                                  | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` `impact:session-state` +3             |             |
| [ ]       | P1       | #63491 | [Bug]: Windows Scheduled Task gateway restart/health becomes inconsistent after ready                                                                                                   | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` `impact:session-state` +2                    | @vincentkoc |
| [ ]       | P1       | #59281 | [Bug]: Windows plugin TS source-loading via jiti is pathologically slow in real production call sites                                                                                   | `bug` `stale` `bug:behavior` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` +4                                                                           |             |
| [ ]       | P1       | #54669 | [Field Report] Chrome 136+ binds CDP to [::1] (IPv6) on Windows — portproxy v4tov4 breaks silently                                                                                      | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `issue-rating: 🦞 diamond lobster` +1     |             |
| [ ]       | P2       | #95072 | fix: Windows /restart falls back to in-process restart without changing PID                                                                                                             | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `issue-rating: 🦞 diamond lobster` +1              |             |
| [ ]       | P2       | #85262 | Windows: lstat bottleneck causes 2-3x slower performance vs Mac (59% of CPU time)                                                                                                       | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-product-decision` `clawsweeper:linked-pr-open` `clawsweeper:needs-live-repro` `issue-rating: 🐚 platinum hermit` +1          |             |
| [ ]       | P2       | #80650 | [Bug]: [Bug] openclaw backup create 在Windows上失败（退出代码255）                                                                                                                      | `bug` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-info` +2                                    |             |
| [ ]       | P2       | #79899 | DefaultResourceLoader.reload() blocks event loop for 12-15s on Windows due to synchronous filesystem scanning                                                                           | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` +2      |             |
| [ ]       | P2       | #78640 | fix(memory): EPERM on Windows persists after 64187 retry — needs copyFile/unlink fallback (was in closed PR 71611)                                                                      | `no-stale` `P1` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:source-repro` `impact:session-state` +2                                                   |             |
| [ ]       | P2       | #77730 | [Bug]: file-transfer plugin nodeHostCommands not advertised by Windows node host on live handshake (2026.5.3-1)                                                                         | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` `issue-rating: 🐚 platinum hermit` `impact:other`                          |             |
| [ ]       | P2       | #58139 | [Bug]: memory-lancedb plugin fails with Windows Docker bind mount                                                                                                                       | `bug` `bug:behavior` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:linked-pr-open` `clawsweeper:needs-live-repro` +2                                                             |             |
| [ ]       | P2       | #44291 | Add native PowerShell smoke coverage for contributor commands                                                                                                                           | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `issue-rating: 🦞 diamond lobster` +1              |             |
| [ ]       | P2       | #40694 | Browser-opened temporary tabs/windows should close automatically after task completion                                                                                                  | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` +2          |             |

### Feature Requests

| Resolved? | Priority | #      | Title                                                                                                                                     | Labels                                                                                                                                                                           | Assignee    |
| --------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| [ ]       | P0       | #89223 | [Bug]: SecretRef file provider broken on Windows 11 26200 — icacls /sid unsupported, preflight validator ignores allowInsecurePath        | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-security-review` +4 |             |
| [ ]       | P0       | #72595 | [Feature]: Feishu channel needs per-channel proxy bypass for mixed Windows proxy setups                                                   | `enhancement` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +6                       |             |
| [ ]       | P0       | #57775 | Windows headless node host supports exec approvals via CLI, but nodes describe / Control UI do not advertise system.execApprovals.get/set | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:security` `issue-rating: 🦞 diamond lobster`                                    | @vincentkoc |
| [ ]       | P0       | #75    | Linux/Windows Clawdbot Apps                                                                                                               | `enhancement` `help wanted` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +3                                       |             |
| [ ]       | P2       | #95259 | [Feature Request] Windows 版本缺失「沉浸音效」配置项                                                                                      | `P3` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` `issue-rating: 🐚 platinum hermit`    |             |
| [ ]       | P2       | #46590 | Feature Request: Add `cron` field to Agent configuration for Agent-owned scheduled tasks                                                  | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `issue-rating: 🌊 off-meta tidepool` `impact:other`                  |             |
| [ ]       | P2       | #18985 | [Feature]: Supports Windows 11 MSYS environment and Fishshell.                                                                            | `enhancement` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +4                       |             |
| [ ]       | P2       | #7057  | Flaky tests on Windows/WSL: timeouts and ENOENT in pi-tools workspace-paths & safe-bins                                                   | `enhancement` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` `issue-rating: 🐚 platinum hermit` +1                        |             |

---

## 4. Windows Platform — PRs

| Resolved? | Priority | #      | Title                                                                                                  | Size | Assignee    |
| --------- | -------- | ------ | ------------------------------------------------------------------------------------------------------ | ---- | ----------- |
| [ ]       | P0       | #97086 | feat(mxc): add Windows MXC sandbox backend                                                             | XL   |             |
| [ ]       | P0       | #96164 | fix(exec): resolve PowerShell 7 via where.exe on Windows                                               | S    |             |
| [ ]       | P0       | #91490 | fix(supervisor): spawn claude .cmd shim correctly on Windows                                           | XS   |             |
| [ ]       | P0       | #88163 | fix(cli): harden Windows node pairing and approvals                                                    | XL   | @vincentkoc |
| [ ]       | P0       | #85264 | fix(infra): scope Windows path realpath caches                                                         | M    | @vincentkoc |
| [ ]       | P0       | #81443 | fix: resolve QMD Windows shims and guard image URL downloads                                           | XL   | @vincentkoc |
| [ ]       | P0       | #73751 | fix(exec): decode Windows command output with codepage-aware streaming                                 | M    | @vincentkoc |
| [ ]       | P0       | #70762 | refactor(agents): share hook history windows                                                           | XL   | @vincentkoc |
| [ ]       | P1       | #90365 | test(browser): replace broad win32 skip with dynamic directory symlink check                           | XS   |             |
| [ ]       | P1       | #90273 | test: make fs-safe hardlink tests compatible with Windows                                              | XS   |             |
| [ ]       | P1       | #90271 | test: make fs-safe symlink tests compatible with Windows                                               | S    |             |
| [ ]       | P1       | #88361 | fix(daemon): clean stale Windows startup fallback                                                      | S    | @vincentkoc |
| [ ]       | P1       | #88311 | fix(windows): repair doctor update fallback migration                                                  | L    | @vincentkoc |
| [ ]       | P1       | #69059 | fix: retry sqlite-vec load without .dll suffix on Windows                                              | S    |             |
| [ ]       | P2       | #96839 | fix: add windowsHide to all spawn calls to prevent visible console windows on Windows                  | XS   |             |
| [ ]       | P2       | #96462 | fix(codex): keep mirrored history continuity for large context windows                                 | S    |             |
| [ ]       | P2       | #96024 | fix(media): normalize Windows inbound paths case-insensitively                                         | XS   |             |
| [ ]       | P2       | #95982 | fix(json-parse): exclude code-context tails from Windows-path heuristic (#93139)                       | S    |             |
| [ ]       | P2       | #95095 | fix(supervisor): probe schtasks directly when env vars are missing                                     | S    |             |
| [ ]       | P2       | #94576 | fix #92054: resolve claude/codex .cmd shims on Windows                                                 | XS   |             |
| [ ]       | P2       | #94514 | docs: add Windows pnpm fallback for Corepack EPERM                                                     | XS   |             |
| [ ]       | P2       | #93299 | fix(daemon): prove Windows schtasks launch without foreground listener [AI]                            | XS   |             |
| [ ]       | P2       | #92119 | fix(supervisor): resolve Claude/Gemini CLI .cmd shims on Windows [AI-assisted] (alternative to #91490) | XS   | @vincentkoc |
| [ ]       | P2       | #91610 | ci(windows): add native PowerShell smoke coverage for contributor commands                             | XS   |             |
| [ ]       | P2       | #91609 | fix(docs): make check:docs work in native PowerShell on Windows                                        | XS   |             |
| [ ]       | P2       | #91273 | fix(windows): remove findstr from scheduled-task restart probe (Fixes #84600)                          | XS   |             |
| [ ]       | P2       | #90280 | test: make zalo token resolver symlink test compatible with Windows                                    | XS   |             |
| [ ]       | P2       | #90230 | test: run permission hardening backup test on Windows                                                  | XS   |             |
| [ ]       | P2       | #90227 | test: make zalo credentials tests compatible with Windows                                              | S    |             |
| [ ]       | P2       | #90217 | test: make doctor state integrity symlink test robust on Windows                                       | XS   |             |
| [ ]       | P2       | #90204 | fix(windows): resolve compatibility, path redaction, symlink EPERM, and channel sorting issues         | S    |             |
| [ ]       | P2       | #88292 | fix(update): guard Windows task autostart during package updates                                       | L    | @vincentkoc |
| [ ]       | P2       | #88114 | fix(windows): disable scheduled task before stop to prevent PT3M re-trigger during update              | XS   |             |
| [ ]       | P2       | #87937 | fix(browser): read Windows Chrome version from build dir in doctor                                     | S    |             |
| [ ]       | P2       | #87344 | fix(browser): read Chrome version from PE metadata on Windows                                          | XS   |             |
| [ ]       | P2       | #84280 | fix: handle SIGUSR1 restart on Windows where the signal is unsupported                                 | S    |             |
| [ ]       | P2       | #80683 | fix(memory-lancedb): add retry mechanism for Windows Docker bind mount sync delays                     | M    |             |
| [ ]       | P2       | #76245 | [codex] Fallback when Windows gateway task exits early                                                 | S    |             |
| [ ]       | P2       | #74425 | fix: ensure CLI processes exit after command completion on Windows                                     | S    |             |
| [ ]       | P2       | #59705 | [codex] improve parallels windows smoke logging                                                        | M    |             |

---

## 5. WSL (Windows Subsystem for Linux) — Issues

### Bugs / Crashes

| Resolved? | Priority | #      | Title                                                                                                                                           | Labels                                                                                                                                                                            | Assignee              |
| --------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| [ ]       | P0       | #91522 | member-info fails with "fetch failed" on WSL2 in 2026.6.1 (SSRF fetch guard / undici dispatcher regression)                                     | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-security-review` `clawsweeper:needs-live-repro` +3 |                       |
| [ ]       | P1       | #86752 | [Bug]: 2026.5.22 Docker/WSL2 gateway event-loop starvation, 284s provider-auth prewarm, slow Telegram turn, and local RPC timeouts              | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:linked-pr-open` +5         | @vincentkoc           |
| [ ]       | P1       | #85537 | Build fails resolving protobufjs google/protobuf descriptor on WSL source checkout                                                              | `maintainer` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:linked-pr-open` `clawsweeper:needs-info` `impact:crash-loop` +1                                                        | @vincentkoc           |
| [ ]       | P1       | #84610 | [Bug]: Gateway loops with SIGTERM every ~90s after upgrade 2026.4.23→2026.5.18 (WSL2). Inbound msg received but cli watchdog kills mid-response | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-info` +3             |                       |
| [ ]       | P1       | #73602 | [Bug]: WhatsApp flaps and Telegram polling stalls on WSL2 in 2026.4.26                                                                          | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-info` `impact:session-state` +3                    |                       |
| [ ]       | P2       | #92777 | [Bug]: TUI: Backspace key stops working after agent response renders (WSL2/Ubuntu)                                                              | `bug` `bug:behavior` `P1` `clawsweeper:needs-info` `issue-rating: 🦐 gold shrimp` `impact:other`                                                                                  |                       |
| [ ]       | P2       | #90953 | [Bug]: installing error message "WSL version output did not include a parseable WSL version"                                                    | `bug` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` +3                                   |                       |
| [ ]       | P2       | #86314 | [Bug] openclaw-weixin channel not registered in gateway runtime - invalid channels.start channel on WSL2                                        | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:message-loss` `issue-rating: 🦞 diamond lobster`                                 | @vincentkoc, @sliverp |
| [ ]       | P2       | #80336 | [Bug]: placeholder.openclaw.cloud unreachable on WSL2 with custom gateway port                                                                  | `bug` `bug:behavior` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +3                                               |                       |

### Feature Requests

_No currently open items found._

---

## 6. WSL (Windows Subsystem for Linux) — PRs

| Resolved? | Priority | #      | Title                                                  | Size | Assignee |
| --------- | -------- | ------ | ------------------------------------------------------ | ---- | -------- |
| [ ]       | P0       | #85711 | docs: add WSL build troubleshooting to CONTRIBUTING.md | XS   |          |

---

## 7. Azure (Provider / Infrastructure) — Issues

### Bugs / Crashes

| Resolved? | Priority | #      | Title                                                                                                                                | Labels                                                                                                                                                                            | Assignee |
| --------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [ ]       | P0       | #79570 | openai-responses adapter is unusable against Azure OpenAI: every turn returns a synthetic 0-token refusal (openai-completions works) | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-security-review` `clawsweeper:needs-live-repro` +4 |          |
| [ ]       | P1       | #95894 | Plugin installs crash Express 4.x routes: core npm-shrinkwrap pins path-to-regexp@8.x but no central override covers plugins         | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `impact:crash-loop` +1                     |          |
| [ ]       | P1       | #93781 | azure-openai-responses probe/agent route uses OpenAI auth profile instead of Azure credentials                                       | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:auth-provider` `issue-rating: 🦞 diamond lobster`                                |          |
| [ ]       | P1       | #80926 | Azure OpenAI Responses stalls before first event when memory tools are exposed                                                       | `maintainer` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +4                         |          |
| [ ]       | P2       | #48788 | feat: centralized filename encoding utility for multi-encoding Content-Disposition handling                                          | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `impact:data-loss` +1                      |          |

### Feature Requests

| Resolved? | Priority | #      | Title                                                                                           | Labels                                                                                                                                                               | Assignee |
| --------- | -------- | ------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [ ]       | P0       | #87325 | Support Azure Foundry GPT Realtime Talk via gateway relay                                       | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-security-review` `impact:security` +2 |          |
| [ ]       | P1       | #71058 | [Feature]: Support for multiple Azure/Teams bots on a single Openclaw Gateway                   | `enhancement` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +3           |          |
| [ ]       | P2       | #90842 | [Feature]: Document and/or centralize the per-event cfg re-resolve contract for channel plugins | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `impact:message-loss` +1      |          |

---

## 8. Azure (Provider / Infrastructure) — PRs

| Resolved? | Priority | #      | Title                                                                            | Size | Assignee |
| --------- | -------- | ------ | -------------------------------------------------------------------------------- | ---- | -------- |
| [ ]       | P0       | #70922 | refactor(whatsapp): centralize account policy                                    | L    |          |
| [ ]       | P1       | #93833 | fix(azure): responses model aliases route correctly                              | M    |          |
| [ ]       | P2       | #97217 | fix(azure-openai-responses): bound SSE response reads via buildGuardedModelFetch | S    |          |
| [ ]       | P2       | #96000 | fix(session-lock): allow reentrant acquire from inner transcript writers         | XS   |          |

---

## 9. Microsoft 365 / SharePoint — Issues

### Bugs / Crashes

_No currently open items found._

### Feature Requests

_No currently open items found._

---

## 10. Microsoft 365 / SharePoint — PRs

_No currently open items found._

---

## Appendix: P0 Blockers (Start Here)

| Category                  | Type  | Priority | #      | Title                                                                                                                                                    |
| ------------------------- | ----- | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MS Teams (channel plugin) | issue | P0       | #92452 | msteams: ClawHub install can never pass the 6.x keyed-store trust gate (official catalog is npmSpec-only) — channel crash-loops with no actionable error |
| MS Teams (channel plugin) | pr    | P0       | #95764 | fix(msteams): allow groupAllowFrom to match conversation IDs                                                                                             |
| MS Teams (channel plugin) | pr    | P0       | #94978 | feat(msteams): Microsoft Teams voice (CVI) + video + chat + governance                                                                                   |
| MS Teams (channel plugin) | pr    | P0       | #93342 | pipeline: normalized provider→channel stream grammar (core)                                                                                              |
| MS Teams (channel plugin) | pr    | P0       | #92725 | External reranker                                                                                                                                        |
| MS Teams (channel plugin) | pr    | P0       | #92603 | fix(cron): summarize shell failures directly                                                                                                             |
| MS Teams (channel plugin) | pr    | P0       | #91722 | Refactor HTTP egress around external proxy enforcement                                                                                                   |
| MS Teams (channel plugin) | pr    | P0       | #91438 | feat(voice-call): Microsoft Teams provider — CVI voice/video calls                                                                                       |
| MS Teams (channel plugin) | pr    | P0       | #91069 | Feat/mordiem document reader skill                                                                                                                       |
| MS Teams (channel plugin) | pr    | P0       | #89796 | IDR-msteams-aad-sender-identity: feat(msteams): add AAD sender identi…                                                                                   |
| MS Teams (channel plugin) | pr    | P0       | #87169 | Support separate Teams Graph tenant                                                                                                                      |
| MS Teams (channel plugin) | pr    | P0       | #81402 | refactor: move runtime state to SQLite                                                                                                                   |
| MS Teams (channel plugin) | pr    | P0       | #77784 | Add Teams delegated auth for plugin tools                                                                                                                |
| MS Teams (channel plugin) | pr    | P0       | #70990 | feat(plugins): add model failover and terminal failure hooks                                                                                             |
| MS Teams (channel plugin) | pr    | P0       | #55828 | feat(msteams): add native plugin interactivity parity                                                                                                    |
| Windows platform          | issue | P0       | #89527 | 建议：为国内 Windows 用户提供一键安装器方案                                                                                                              |
| Windows platform          | issue | P0       | #89223 | [Bug]: SecretRef file provider broken on Windows 11 26200 — icacls /sid unsupported, preflight validator ignores allowInsecurePath                       |
| Windows platform          | issue | P0       | #83890 | Windows restart script builds ProcessStartInfo.Arguments via string concatenation without quoting embedded double-quotes                                 |
| Windows platform          | issue | P0       | #72595 | [Feature]: Feishu channel needs per-channel proxy bypass for mixed Windows proxy setups                                                                  |
| Windows platform          | issue | P0       | #57775 | Windows headless node host supports exec approvals via CLI, but nodes describe / Control UI do not advertise system.execApprovals.get/set                |
| Windows platform          | issue | P0       | #75    | Linux/Windows Clawdbot Apps                                                                                                                              |
| Windows platform          | pr    | P0       | #97086 | feat(mxc): add Windows MXC sandbox backend                                                                                                               |
| Windows platform          | pr    | P0       | #96164 | fix(exec): resolve PowerShell 7 via where.exe on Windows                                                                                                 |
| Windows platform          | pr    | P0       | #91490 | fix(supervisor): spawn claude .cmd shim correctly on Windows                                                                                             |
| Windows platform          | pr    | P0       | #88163 | fix(cli): harden Windows node pairing and approvals                                                                                                      |
| Windows platform          | pr    | P0       | #85264 | fix(infra): scope Windows path realpath caches                                                                                                           |
| Windows platform          | pr    | P0       | #81443 | fix: resolve QMD Windows shims and guard image URL downloads                                                                                             |
| Windows platform          | pr    | P0       | #73751 | fix(exec): decode Windows command output with codepage-aware streaming                                                                                   |
| Windows platform          | pr    | P0       | #70762 | refactor(agents): share hook history windows                                                                                                             |
| WSL                       | issue | P0       | #91522 | member-info fails with "fetch failed" on WSL2 in 2026.6.1 (SSRF fetch guard / undici dispatcher regression)                                              |
| WSL                       | pr    | P0       | #85711 | docs: add WSL build troubleshooting to CONTRIBUTING.md                                                                                                   |
| Azure                     | issue | P0       | #87325 | Support Azure Foundry GPT Realtime Talk via gateway relay                                                                                                |
| Azure                     | issue | P0       | #79570 | openai-responses adapter is unusable against Azure OpenAI: every turn returns a synthetic 0-token refusal (openai-completions works)                     |
| Azure                     | pr    | P0       | #70922 | refactor(whatsapp): centralize account policy                                                                                                            |

## Appendix: High-Priority Bugs / Regressions

| Category                  | Type  | Priority | #      | Title                                                                                                                                                                                   |
| ------------------------- | ----- | -------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MS Teams (channel plugin) | issue | P1       | #67177 | [msteams] Inbound file attachments silently fail in DMs — file.download.info downloadUrl not rewritten to Graph shares endpoint                                                         |
| MS Teams (channel plugin) | pr    | P1       | #94300 | fix(gateway): deliver OAuth authorization URLs to non-terminal clients                                                                                                                  |
| MS Teams (channel plugin) | pr    | P1       | #92591 | feat(msteams): respond to channel messages by keyword without an @mention                                                                                                               |
| MS Teams (channel plugin) | pr    | P1       | #91644 | feat(gateway): add OpenAI-compatible /v1/audio/speech endpoint                                                                                                                          |
| MS Teams (channel plugin) | pr    | P1       | #90622 | fix(ports): batch macOS lsof listener inspection to one spawn per cycle                                                                                                                 |
| MS Teams (channel plugin) | pr    | P1       | #89944 | Idr msteams adaptive card tables                                                                                                                                                        |
| MS Teams (channel plugin) | pr    | P1       | #88845 | Require signed beta desktop distribution                                                                                                                                                |
| MS Teams (channel plugin) | pr    | P1       | #82354 | fix(msteams): emit message:sent hook on reply delivery                                                                                                                                  |
| MS Teams (channel plugin) | pr    | P1       | #79185 | fix(tts/xiaomi): support Token Plan TTS endpoint                                                                                                                                        |
| MS Teams (channel plugin) | pr    | P1       | #77921 | feat(inworld): default to inworld-tts-2 (Realtime TTS-2)                                                                                                                                |
| MS Teams (channel plugin) | pr    | P1       | #75043 | Add provider-aware automatic TTS emotion mapping                                                                                                                                        |
| MS Teams (channel plugin) | pr    | P1       | #59986 | refactor(plugins): add lane-oriented channel interface                                                                                                                                  |
| Windows platform          | issue | P1       | #96835 | [Bug]: exec tool on Windows (v2026.6.10) pops visible cmd/PowerShell window for every command — regression from v2026.6.8                                                               |
| Windows platform          | issue | P1       | #93081 | [Bug]: Ctrl+C not working in Windows install on foreground                                                                                                                              |
| Windows platform          | issue | P1       | #92054 | [Bug]: Windows 11 - Claude CLI provider fails with spawn claude ENOENT                                                                                                                  |
| Windows platform          | issue | P1       | #91675 | fetch failed / UND_ERR_SOCKET on Windows WSL when connecting to Google Gemini                                                                                                           |
| Windows platform          | issue | P1       | #91489 | Windows: spawning claude via child_process fails (ENOENT/EINVAL) due to missing .cmd handling                                                                                           |
| Windows platform          | issue | P1       | #91144 | [Bug]: Windows native CLI gateway Scheduled Task does not stay running; foreground window worksWindows native CLI gateway Scheduled Task does not stay running; foreground window works |
| Windows platform          | issue | P1       | #90548 | macOS: per-port lsof port-health polling can saturate launchservicesd and trigger a WindowServer watchdog reboot                                                                        |
| Windows platform          | issue | P1       | #90158 | Gateway self-restart on Windows fails silently when schtasks /Run cannot relaunch the scheduled task                                                                                    |
| Windows platform          | issue | P1       | #88373 | Windows post-onboarding provider switch path is not discoverable                                                                                                                        |
| Windows platform          | issue | P1       | #88372 | Windows provider switch leaves stale model/provider config and session cache                                                                                                            |
| Windows platform          | issue | P1       | #88371 | Windows QuickStart defaults first chat to paid Anthropic model without credit warning                                                                                                   |
| Windows platform          | issue | P1       | #87993 | [Bug]: Windows — openclaw update 期间 Scheduled Task PT3M 重复触发器重新拉起 gateway 导致竞态                                                                                           |
| Windows platform          | issue | P1       | #87156 | [Bug]: Windows doctor update leaves Startup-folder gateway fallback stale and does not install Scheduled Task                                                                           |
| Windows platform          | issue | P1       | #87136 | compaction: absolute token thresholds break when switching models with different context windows                                                                                        |
| Windows platform          | issue | P1       | #86987 | [Bug]: [Regression] Gateway 5.18+ shows empty Caps for all node versions on Windows/Docker                                                                                              |
| Windows platform          | issue | P1       | #86031 | [Bug]: Windows gateway listens but local health/status time out after Telegram polling stall (v2026.5.20)                                                                               |
| Windows platform          | issue | P1       | #85268 | [Bug]: [Windows] exec spawn: all commands hang with no output (stdio pipe deadlock)                                                                                                     |
| Windows platform          | issue | P1       | #84600 | Bug: Windows heartbeat cmd window not hidden - 'findstr /I /C:"Running"' stays visible                                                                                                  |
| Windows platform          | issue | P1       | #84213 | [Bug]: openclaw completion -s zsh hangs on native Windows (no WSL)                                                                                                                      |
| Windows platform          | issue | P1       | #84203 | [Bug]: Windows — models.authStatus cold latency 10-24s per CLI session (2026.5.18 + Codex 0.131.0)                                                                                      |
| Windows platform          | issue | P1       | #84001 | Windows: openclaw status / status --json hangs in 2026.5.18 while status --all succeeds                                                                                                 |
| Windows platform          | issue | P1       | #83277 | WhatsApp channel: "web login provider is not available" on Windows despite wacli installed and authenticated                                                                            |
| Windows platform          | issue | P1       | #80416 | [Bug] core-plugin-tools ~3.5s overhead on every embedded run persists after #75520 fix — Windows + Node 24 + isolated cron jobs                                                         |
| Windows platform          | issue | P1       | #80344 | [Bug]: Discord voice /vc join fails on Windows with AggregateError + gateway heartbeat timeout / event loop starvation                                                                  |
| Windows platform          | issue | P1       | #79437 | Prebuilt `node-llama-cpp` Windows binaries crash (0xC0000005) on Intel Alder Lake-N (N95) — qmd LLM half unusable                                                                       |
| Windows platform          | issue | P1       | #77443 | [Bug]: WhatsApp event loop blocked (eventLoopDelayMaxMs=12088ms) on first inbound message — 2026.5.3-1 Windows                                                                          |
| Windows platform          | issue | P1       | #74378 | [Bug]: OpenClaw CLI commands remain alive as node.exe processes after execution on Windows                                                                                              |
| Windows platform          | issue | P1       | #71865 | Auth login blocked by size-drop guard when openclaw.json was created by PowerShell (verbose/BOM format)                                                                                 |
| Windows platform          | issue | P1       | #71699 | [Bug]: Gateway hard-crashes with 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) on Windows during Mattermost streaming reply; auto-respawn frequently wedges                                  |
| Windows platform          | issue | P1       | #63491 | [Bug]: Windows Scheduled Task gateway restart/health becomes inconsistent after ready                                                                                                   |
| Windows platform          | issue | P1       | #59281 | [Bug]: Windows plugin TS source-loading via jiti is pathologically slow in real production call sites                                                                                   |
| Windows platform          | issue | P1       | #54669 | [Field Report] Chrome 136+ binds CDP to [::1] (IPv6) on Windows — portproxy v4tov4 breaks silently                                                                                      |
| Windows platform          | pr    | P1       | #90365 | test(browser): replace broad win32 skip with dynamic directory symlink check                                                                                                            |
| Windows platform          | pr    | P1       | #90273 | test: make fs-safe hardlink tests compatible with Windows                                                                                                                               |
| Windows platform          | pr    | P1       | #90271 | test: make fs-safe symlink tests compatible with Windows                                                                                                                                |
| Windows platform          | pr    | P1       | #88361 | fix(daemon): clean stale Windows startup fallback                                                                                                                                       |
| Windows platform          | pr    | P1       | #88311 | fix(windows): repair doctor update fallback migration                                                                                                                                   |
| Windows platform          | pr    | P1       | #69059 | fix: retry sqlite-vec load without .dll suffix on Windows                                                                                                                               |
| WSL                       | issue | P1       | #86752 | [Bug]: 2026.5.22 Docker/WSL2 gateway event-loop starvation, 284s provider-auth prewarm, slow Telegram turn, and local RPC timeouts                                                      |
| WSL                       | issue | P1       | #85537 | Build fails resolving protobufjs google/protobuf descriptor on WSL source checkout                                                                                                      |
| WSL                       | issue | P1       | #84610 | [Bug]: Gateway loops with SIGTERM every ~90s after upgrade 2026.4.23→2026.5.18 (WSL2). Inbound msg received but cli watchdog kills mid-response                                         |
| WSL                       | issue | P1       | #73602 | [Bug]: WhatsApp flaps and Telegram polling stalls on WSL2 in 2026.4.26                                                                                                                  |
| Azure                     | issue | P1       | #95894 | Plugin installs crash Express 4.x routes: core npm-shrinkwrap pins path-to-regexp@8.x but no central override covers plugins                                                            |
| Azure                     | issue | P1       | #93781 | azure-openai-responses probe/agent route uses OpenAI auth profile instead of Azure credentials                                                                                          |
| Azure                     | issue | P1       | #80926 | Azure OpenAI Responses stalls before first event when memory tools are exposed                                                                                                          |
| Azure                     | issue | P1       | #71058 | [Feature]: Support for multiple Azure/Teams bots on a single Openclaw Gateway                                                                                                           |
| Azure                     | pr    | P1       | #93833 | fix(azure): responses model aliases route correctly                                                                                                                                     |

## Appendix: Stale Items (Consider Closing)

| Category                  | Type  | Priority | #      | Title                                                                                                   |
| ------------------------- | ----- | -------- | ------ | ------------------------------------------------------------------------------------------------------- |
| MS Teams (channel plugin) | issue | P2       | #81084 | [Feature]: MSTeams channel-bound agents need opt-out from per-thread sessions                           |
| MS Teams (channel plugin) | pr    | P2       | #87304 | fix(update): fail closed on managed plugin pin conflicts                                                |
| MS Teams (channel plugin) | pr    | P2       | #85845 | fix(msteams): route file.download.info links via graph shares                                           |
| MS Teams (channel plugin) | pr    | P2       | #85478 | fix(slack): soften benign search no-result progress                                                     |
| Windows platform          | issue | P1       | #71865 | Auth login blocked by size-drop guard when openclaw.json was created by PowerShell (verbose/BOM format) |
| Windows platform          | issue | P1       | #59281 | [Bug]: Windows plugin TS source-loading via jiti is pathologically slow in real production call sites   |
| Windows platform          | pr    | P0       | #85264 | fix(infra): scope Windows path realpath caches                                                          |
| Windows platform          | pr    | P0       | #81443 | fix: resolve QMD Windows shims and guard image URL downloads                                            |

## Audit Notes

- Rebuilt from the format of PR #49126 after the issue/PR purge.
- Source set is currently open GitHub issues and PRs from `openclaw/openclaw`; closed counts are intentionally reset to `0` for this refreshed tracker.
- Included title/label matches for `msteams`, Microsoft Teams, Windows, WSL, Azure, Entra/AAD, MSAL, managed identity, DefaultAzureCredential, Microsoft Graph, SharePoint, OneDrive, and Microsoft 365.
- Kept broad multi-channel PRs when they carry `channel: msteams`, because those can still affect the Microsoft surface area.
- Generated with `node scripts/generate-microsoft-tracker.mjs` so the tracker and PR body can be refreshed after future triage passes.
