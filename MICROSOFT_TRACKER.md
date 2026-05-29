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
> **Last updated:** 2026-05-29 (post-purge audit: refreshed from currently open GitHub issues/PRs and rebuilt from PR #49126 format)

---

## Summary

| Category                  | Issues | PRs    | Total   | Closed | Remaining |
| ------------------------- | ------ | ------ | ------- | ------ | --------- |
| MS Teams (channel plugin) | 6      | 40     | 46      | 0      | 46        |
| Windows platform          | 65     | 24     | 89      | 0      | 89        |
| WSL                       | 11     | 4      | 15      | 0      | 15        |
| Azure                     | 10     | 3      | 13      | 0      | 13        |
| SharePoint / M365         | 0      | 0      | 0       | 0      | 0         |
| **Total**                 | **92** | **71** | **163** | **0**  | **163**   |

---

## 1. MS Teams Channel Plugin — Issues

### Bugs / Crashes

| Resolved? | Priority | #      | Title                                                                                                                           | Labels                                                                                                                                                                  | Assignee |
| --------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [ ]       | P1       | #85149 | [Bug]: msteams federated managed identity ignores FIC, leaks MI appid in outbound Bot Framework calls                           | `P1` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:source-repro` `impact:message-loss` `impact:auth-provider` +1                               |          |
| [ ]       | P1       | #67177 | [msteams] Inbound file attachments silently fail in DMs — file.download.info downloadUrl not rewritten to Graph shares endpoint | `P1` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:source-repro` `impact:message-loss` `issue-rating: 🦞 diamond lobster`                      |          |
| [ ]       | P1       | #65329 | bug(msteams): DM inline images and file attachments silently dropped                                                            |                                                                                                                                                                         |          |
| [ ]       | P1       | #62765 | msteams dmPolicy=pairing silently drops unpaired senders with HTTP 200, no log line, no auto-reply                              | `P1` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:source-repro` `impact:message-loss` `issue-rating: 🦞 diamond lobster`                      |          |
| [ ]       | P2       | #42099 | fix(plugins): false-positive duplicate plugin ID warning on gateway start (msteams)                                             | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` +2 |          |

### Feature Requests

| Resolved? | Priority | #      | Title                                                                         | Labels | Assignee |
| --------- | -------- | ------ | ----------------------------------------------------------------------------- | ------ | -------- |
| [ ]       | P2       | #81084 | [Feature]: MSTeams channel-bound agents need opt-out from per-thread sessions |        |          |

---

## 2. MS Teams Channel Plugin — PRs

| Resolved? | Priority | #      | Title                                                                                                            | Size | Assignee    |
| --------- | -------- | ------ | ---------------------------------------------------------------------------------------------------------------- | ---- | ----------- |
| [ ]       | P0       | #87296 | feat: group model select with collapsible panel in Control UI                                                    | XL   |             |
| [ ]       | P0       | #87202 | refactor: internalize OpenClaw agent runtime                                                                     | XL   |             |
| [ ]       | P0       | #85651 | feat(continuation): context-pressure-aware continuation (continue_work / continue_delegate / request_compaction) | XL   |             |
| [ ]       | P0       | #81729 | Remove system event trust metadata                                                                               | S    |             |
| [ ]       | P0       | #81402 | refactor: move runtime state to SQLite                                                                           | XL   |             |
| [ ]       | P0       | #77784 | Add Teams delegated auth for plugin tools                                                                        | XL   |             |
| [ ]       | P0       | #70864 | feat: add scoped mention pattern policy                                                                          | XL   |             |
| [ ]       | P0       | #67460 | feat(mention-gating): suppress always-on agent when another agent is explicitly mentioned                        | M    |             |
| [ ]       | P0       | #67174 | Teams: support separate graphTenantId for cross-tenant Graph API access                                          | M    |             |
| [ ]       | P0       | #60643 | feat(agents): cognitive processing scaffolding and structured memory prompt                                      | S    |             |
| [ ]       | P0       | #57511 | feat(msteams): Teams live voice support with .NET media worker                                                   | XL   |             |
| [ ]       | P0       | #55828 | feat(msteams): add native plugin interactivity parity                                                            | XL   |             |
| [ ]       | P0       | #55485 | Config: plumb opt-in SSRF policy for web fetch, citation redirects, and remote media                             | L    |             |
| [ ]       | P1       | #87169 | Support separate Teams Graph tenant                                                                              | S    |             |
| [ ]       | P1       | #82253 | feat(slack): support per-channel replyToMode                                                                     | XL   |             |
| [ ]       | P1       | #75043 | Add provider-aware automatic TTS emotion mapping                                                                 | XL   |             |
| [ ]       | P2       | #88103 | Update Teams CLI install command                                                                                 | XS   |             |
| [ ]       | P2       | #85845 | fix(msteams): route file.download.info links via graph shares                                                    | XS   |             |
| [ ]       | P2       | #85478 | fix(slack): soften benign search no-result progress                                                              | L    |             |
| [ ]       | P2       | #85058 | fix(plugins): force native require for own dist chunks via jiti nativeModules                                    |      |             |
| [ ]       | P2       | #84560 | feat(cli): support --dm-policy and --dm-allowlist in channels add                                                |      |             |
| [ ]       | P2       | #84206 | fix(agents): cleanup parent agent directory during deletion                                                      |      |             |
| [ ]       | P2       | #82354 | fix(msteams): emit message:sent hook on reply delivery                                                           | M    |             |
| [ ]       | P2       | #79609 | Show session cleanup dry-run counts by label                                                                     | L    |             |
| [ ]       | P2       | #79185 | fix(tts/xiaomi): support Token Plan TTS endpoint                                                                 | S    |             |
| [ ]       | P2       | #78839 | [codex] Add Teams member-info action gate                                                                        | S    |             |
| [ ]       | P2       | #78172 | feat(tts): add skipEmojiSymbols option to prevent TTS from reading emoji/symbols                                 | M    |             |
| [ ]       | P2       | #77921 | feat(inworld): default to inworld-tts-2 (Realtime TTS-2)                                                         | XS   |             |
| [ ]       | P2       | #76560 | feat(plugins): allow community plugins to use openKeyedStore with man…                                           | L    | @vincentkoc |
| [ ]       | P2       | #70287 | fix(msteams): drop unsupported $search on msteams:search (AI-assisted)                                           | M    |             |
| [ ]       | P2       | #69428 | fix(msteams): paginate thread replies and keep recent context                                                    | S    |             |
| [ ]       | P2       | #67761 | fix: remove truncated preview from inbound system events                                                         | XS   |             |
| [ ]       | P2       | #66327 | feat(msteams): implement sendPayload for interactive approval cards                                              | M    |             |
| [ ]       | P2       | #64503 | fix(msteams): forward messageBack card actions (Action.Submit) to agent (#60952)                                 | S    |             |
| [ ]       | P2       | #63347 | feat(msteams): support webhook host binding                                                                      | S    |             |
| [ ]       | P2       | #60630 | fix(ci): Windows task tests and Telegram setup promotion surface                                                 | L    |             |
| [ ]       | P2       | #59986 | refactor(plugins): add lane-oriented channel interface                                                           | XL   |             |
| [ ]       | P2       | #57366 | fix(msteams): extract emoji unicode from Teams CDN img tags instead of treating as image attachments             | S    |             |
| [ ]       | P2       | #57364 | fix(msteams): delete FileConsentCard after user accepts, declines, or upload expires                             | S    |             |
| [ ]       | P2       | #46303 | fix: drain inbound debounce buffer and followup queues before SIGUSR1 reload                                     | XL   |             |

---

## 3. Windows Platform — Issues

### Bugs / Crashes

| Resolved? | Priority | #      | Title                                                                                                                                                   | Labels                                                                                                                                                                      | Assignee              |
| --------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| [ ]       | P0       | #48780 | [Bug]: [Windows] exec() and read() commands corrupted with </arg_value>> suffix                                                                         | `bug` `bug:behavior` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-security-review` `clawsweeper:source-repro` +4                                                     |                       |
| [ ]       | P1       | #87993 | [Bug]: Windows — openclaw update 期间 Scheduled Task PT3M 重复触发器重新拉起 gateway 导致竞态                                                           | `P2` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:source-repro` `impact:crash-loop` `issue-rating: 🦞 diamond lobster`                            |                       |
| [ ]       | P1       | #87156 | [Bug]: Windows doctor update leaves Startup-folder gateway fallback stale and does not install Scheduled Task                                           | `P2` `clawsweeper:needs-live-repro` `impact:crash-loop` `issue-rating: 🐚 platinum hermit`                                                                                  |                       |
| [ ]       | P1       | #87136 | compaction: absolute token thresholds break when switching models with different context windows                                                        | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` `impact:session-state` +2        |                       |
| [ ]       | P1       | #86987 | [Bug]: [Regression] Gateway 5.18+ shows empty Caps for all node versions on Windows/Docker                                                              | `bug` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` +2                         |                       |
| [ ]       | P1       | #86599 | [Bug]: Local model provider calls thread block gateway event loop on Windows beta; trivial infer run takes ~4 minutes                                   | `bug` `bug:behavior` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-info` +4                                                     | @vincentkoc, @osolmaz |
| [ ]       | P1       | #86087 | [Bug]: [Beta][Windows] 2026.5.24-beta.1 Codex harness fails: removed plugin-sdk/codex-native-task-runtime export still imported by @openclaw/codex      | `bug` `regression` `P1` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:needs-live-repro` +3                                                         |                       |
| [ ]       | P1       | #86044 | 2026.5.22: CLI hangs on Windows — provider auth-state pre-warm blocks all CLI commands                                                                  | `bug` `regression` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-info` +3                                                       | @osolmaz              |
| [ ]       | P1       | #86031 | [Bug]: Windows gateway listens but local health/status time out after Telegram polling stall (v2026.5.20)                                               | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` `impact:session-state` `impact:message-loss` +2                       |                       |
| [ ]       | P1       | #85268 | [Bug]: [Windows] exec spawn: all commands hang with no output (stdio pipe deadlock)                                                                     | `bug` `bug:crash` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-info` +2                                                        |                       |
| [ ]       | P1       | #84213 | [Bug]: openclaw completion -s zsh hangs on native Windows (no WSL)                                                                                      | `bug` `regression` `P2` `clawsweeper:needs-live-repro` `impact:crash-loop` `issue-rating: 🐚 platinum hermit`                                                               |                       |
| [ ]       | P1       | #84203 | [Bug]: Windows — models.authStatus cold latency 10-24s per CLI session (2026.5.18 + Codex 0.131.0)                                                      | `bug` `regression` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` +2                                                 |                       |
| [ ]       | P1       | #84001 | Windows: openclaw status / status --json hangs in 2026.5.18 while status --all succeeds                                                                 | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` `impact:crash-loop` `issue-rating: 🐚 platinum hermit`                |                       |
| [ ]       | P1       | #83943 | [Bug]: Session resource loader grows unbounded across warm turns — 5.x regression vs 4.23 baseline (Windows + Feishu + MiniMax OAuth)                   | `bug`                                                                                                                                                                       |                       |
| [ ]       | P1       | #83277 | WhatsApp channel: "web login provider is not available" on Windows despite wacli installed and authenticated                                            | `bug` `bug:behavior` `P2` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:source-repro` +1                                                           |                       |
| [ ]       | P1       | #80416 | [Bug] core-plugin-tools ~3.5s overhead on every embedded run persists after #75520 fix — Windows + Node 24 + isolated cron jobs                         | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` `impact:crash-loop`                                                   |                       |
| [ ]       | P1       | #80344 | [Bug]: Discord voice /vc join fails on Windows with AggregateError + gateway heartbeat timeout / event loop starvation                                  | `bug` `bug:crash` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-info` +2                                                        |                       |
| [ ]       | P1       | #79437 | Prebuilt `node-llama-cpp` Windows binaries crash (0xC0000005) on Intel Alder Lake-N (N95) — qmd LLM half unusable                                       |                                                                                                                                                                             |                       |
| [ ]       | P1       | #77443 | [Bug]: WhatsApp event loop blocked (eventLoopDelayMaxMs=12088ms) on first inbound message — 2026.5.3-1 Windows                                          | `bug` `regression`                                                                                                                                                          |                       |
| [ ]       | P1       | #74378 | [Bug]: OpenClaw CLI commands remain alive as node.exe processes after execution on Windows                                                              | `bug` `regression`                                                                                                                                                          |                       |
| [ ]       | P1       | #71865 | Auth login blocked by size-drop guard when openclaw.json was created by PowerShell (verbose/BOM format)                                                 | `P1` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:source-repro` `impact:data-loss` `impact:auth-provider` +1                                      |                       |
| [ ]       | P1       | #71717 | exec tool returns EPERM on Windows, all commands fail                                                                                                   | `bug` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` +2                         |                       |
| [ ]       | P1       | #71699 | [Bug]: Gateway hard-crashes with 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) on Windows during Mattermost streaming reply; auto-respawn frequently wedges  | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-info` `impact:session-state` +3                     |                       |
| [ ]       | P1       | #70788 | fix(windows): suppress startup-folder cmd window flash via wscript silent launcher                                                                      | `P2` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:source-repro` `issue-rating: 🦞 diamond lobster`                                                |                       |
| [ ]       | P1       | #70451 | [Bug]: CLI hooks enable times out / SIGKILL on Windows                                                                                                  | `P1` `clawsweeper:needs-live-repro` `impact:crash-loop` `issue-rating: 🐚 platinum hermit`                                                                                  |                       |
| [ ]       | P1       | #68493 | [Bug]: Editing openclaw.json while gateway is running triggers hot-reload crash loop on Windows (stale lock file + EADDRINUSE)                          | `P1` `clawsweeper:source-repro` `impact:crash-loop` `issue-rating: 🦞 diamond lobster`                                                                                      | @vincentkoc           |
| [ ]       | P1       | #67035 | [Bug]: 2026.4.14 Windows chat UI regression: input text swallowed, streamed replies often invisible until refresh, typing indicator flashes then blanks | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-product-decision` `clawsweeper:linked-pr-open` `clawsweeper:needs-live-repro` `impact:session-state` +2                 | @osolmaz              |
| [ ]       | P1       | #64253 | Gateway becomes unresponsive under subagent load on Windows - completion announcements timeout                                                          | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` `impact:message-loss` `impact:crash-loop` +1                          |                       |
| [ ]       | P1       | #63491 | [Bug]: Windows Scheduled Task gateway restart/health becomes inconsistent after ready                                                                   | `P1` `clawsweeper:source-repro` `impact:session-state` `impact:crash-loop` `issue-rating: 🦞 diamond lobster`                                                               |                       |
| [ ]       | P1       | #63257 | Windows Gateway Feishu API timeout 30s at startup                                                                                                       | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` +3     |                       |
| [ ]       | P1       | #62099 | EPERM on auth-profiles.json causes full gateway failure cascade (Windows)                                                                               | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:auth-provider` `impact:crash-loop` +1                                      |                       |
| [ ]       | P1       | #59362 | [Bug]: Windows: exec tool causes console window flash when spawning commands                                                                            | `bug` `regression` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` +3                                                  |                       |
| [ ]       | P1       | #59281 | [Bug]: Windows plugin TS source-loading via jiti is pathologically slow in real production call sites                                                   | `bug` `bug:behavior` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +3                                         |                       |
| [ ]       | P1       | #54669 | [Field Report] Chrome 136+ binds CDP to [::1] (IPv6) on Windows — portproxy v4tov4 breaks silently                                                      | `P1` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:source-repro` `issue-rating: 🦞 diamond lobster`                                                |                       |
| [ ]       | P1       | #44559 | [Bug]: Windows： Gateway 关闭 PowerShell 窗口后断连                                                                                                     | `bug` `bug:behavior` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` +4                                                |                       |
| [ ]       | P1       | #40540 | [Bug]: `openclaw update` command fails with EBUSY error on Windows                                                                                      | `bug` `bug:behavior` `P1` `clawsweeper:source-repro` `impact:crash-loop` `issue-rating: 🦞 diamond lobster`                                                                 |                       |
| [ ]       | P2       | #85262 | Windows: lstat bottleneck causes 2-3x slower performance vs Mac (59% of CPU time)                                                                       | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:linked-pr-open` `clawsweeper:needs-live-repro` `issue-rating: 🐚 platinum hermit`                                             |                       |
| [ ]       | P2       | #84644 | [Bug]: Windows node-host connects but reports no commands                                                                                               | `bug` `P1` `clawsweeper:needs-info` `issue-rating: 🦐 gold shrimp`                                                                                                          |                       |
| [ ]       | P2       | #84600 | Bug: Windows heartbeat cmd window not hidden - 'findstr /I /C:"Running"' stays visible                                                                  | `P2` `clawsweeper:source-repro` `issue-rating: 🦞 diamond lobster`                                                                                                          |                       |
| [ ]       | P2       | #83890 | Windows restart script builds ProcessStartInfo.Arguments via string concatenation without quoting embedded double-quotes                                |                                                                                                                                                                             |                       |
| [ ]       | P2       | #82594 | [Bug]: openclaw onboard extremely slow on Windows during model loading                                                                                  |                                                                                                                                                                             |                       |
| [ ]       | P2       | #80650 | [Bug]: [Bug] openclaw backup create 在Windows上失败（退出代码255）                                                                                      | `bug`                                                                                                                                                                       |                       |
| [ ]       | P2       | #79899 | DefaultResourceLoader.reload() blocks event loop for 12-15s on Windows due to synchronous filesystem scanning                                           | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-live-repro` +1 |                       |
| [ ]       | P2       | #79099 | Windows gateway probe still reports unreachable while gateway health is OK on 2026.5.6                                                                  |                                                                                                                                                                             |                       |
| [ ]       | P2       | #78640 | fix(memory): EPERM on Windows persists after 64187 retry — needs copyFile/unlink fallback (was in closed PR 71611)                                      |                                                                                                                                                                             |                       |
| [ ]       | P2       | #78435 | [Bug]: `channels.slack.start-account` phase blocks event loop 5+ minutes while a model_call is in flight (Windows, 2026.5.4)                            |                                                                                                                                                                             |                       |
| [ ]       | P2       | #77730 | [Bug]: file-transfer plugin nodeHostCommands not advertised by Windows node host on live handshake (2026.5.3-1)                                         |                                                                                                                                                                             |                       |
| [ ]       | P2       | #76884 | [Bug]: OpenClaw on native Windows getting notably slower and slower with each new version???                                                            | `bug`                                                                                                                                                                       |                       |
| [ ]       | P2       | #76702 | Windows + Feishu DM becomes very slow after upgrade to 2026.5.2; latency appears in agent/session processing, likely amplified by large session context |                                                                                                                                                                             |                       |
| [ ]       | P2       | #76553 | [Bug]: Windows: Claude Code not detected by OpenClaw, Gateway in restart loop after PATH workaround                                                     | `bug` `bug:behavior`                                                                                                                                                        |                       |
| [ ]       | P2       | #73859 | [Bug]: Built-in plugins (minimax, google, talk-voice) fail with RangeError: Maximum call stack size exceeded on Windows                                 |                                                                                                                                                                             |                       |
| [ ]       | P2       | #72922 | [Bug]: Sluggish response time and unstable Web GUI and CLI on Windows Server 2022                                                                       | `bug`                                                                                                                                                                       |                       |
| [ ]       | P2       | #64443 | OpenClaw chat interface causes very high WindowServer CPU on Intel Retina iMac                                                                          | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-info` `issue-rating: 🦐 gold shrimp`         |                       |
| [ ]       | P2       | #58139 | [Bug]: memory-lancedb plugin fails with Windows Docker bind mount                                                                                       | `bug` `bug:behavior` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` +2                                                            |                       |
| [ ]       | P2       | #56284 | Windows: gateway restart does not wait for active tasks and loses session state                                                                         | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `impact:session-state` +3            |                       |
| [ ]       | P2       | #56106 | Transcript JSONL encoding corrupted on Windows (GBK/UTF-8 mix)                                                                                          | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-info` `impact:session-state` `impact:data-loss` +1                                |                       |
| [ ]       | P2       | #44293 | Make `pnpm check:docs` work in native PowerShell                                                                                                        | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:linked-pr-open` `clawsweeper:needs-live-repro` +1                   |                       |
| [ ]       | P2       | #44291 | Add native PowerShell smoke coverage for contributor commands                                                                                           | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `issue-rating: 🌊 off-meta tidepool`                            |                       |
| [ ]       | P2       | #40694 | Browser-opened temporary tabs/windows should close automatically after task completion                                                                  | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` `impact:session-state` +1            |                       |

### Feature Requests

| Resolved? | Priority | #      | Title                                                                                                                                     | Labels                                                                                                                                                     | Assignee |
| --------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [ ]       | P0       | #57775 | Windows headless node host supports exec approvals via CLI, but nodes describe / Control UI do not advertise system.execApprovals.get/set | `P2` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:source-repro` `impact:security` `issue-rating: 🦞 diamond lobster`             |          |
| [ ]       | P0       | #75    | Linux/Windows Clawdbot Apps                                                                                                               | `enhancement` `help wanted` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +4                 |          |
| [ ]       | P2       | #72595 | [Feature]: Feishu channel needs per-channel proxy bypass for mixed Windows proxy setups                                                   | `enhancement`                                                                                                                                              |          |
| [ ]       | P2       | #46590 | Feature Request: Add `cron` field to Agent configuration for Agent-owned scheduled tasks                                                  | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `issue-rating: 🌊 off-meta tidepool`           |          |
| [ ]       | P2       | #18985 | [Feature]: Supports Windows 11 MSYS environment and Fishshell.                                                                            | `enhancement` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` +2 |          |
| [ ]       | P2       | #7057  | Flaky tests on Windows/WSL: timeouts and ENOENT in pi-tools workspace-paths & safe-bins                                                   | `enhancement` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` `issue-rating: 🐚 platinum hermit`     |          |

---

## 4. Windows Platform — PRs

| Resolved? | Priority | #      | Title                                                                                     | Size | Assignee    |
| --------- | -------- | ------ | ----------------------------------------------------------------------------------------- | ---- | ----------- |
| [ ]       | P0       | #85264 | fix(infra): add global realpath cache to eliminate redundant lstat on Windows             | M    |             |
| [ ]       | P0       | #81443 | fix: resolve QMD Windows shims and guard image URL downloads                              | M    |             |
| [ ]       | P0       | #68819 | fix: resolve Windows .cmd shims to underlying .exe before spawn                           | M    |             |
| [ ]       | P0       | #68149 | feat(daemon): use PowerShell Register-ScheduledTask for Windows auto-start                | M    |             |
| [ ]       | P0       | #63651 | fix: remove duplicate restart message on Windows (schtasks)                               | S    |             |
| [ ]       | P1       | #69059 | fix: retry sqlite-vec load without .dll suffix on Windows                                 | S    |             |
| [ ]       | P2       | #88114 | fix(windows): disable scheduled task before stop to prevent PT3M re-trigger during update | XS   |             |
| [ ]       | P2       | #87937 | fix(browser): read Windows Chrome version from build dir in doctor                        | S    |             |
| [ ]       | P2       | #87344 | fix(browser): read Chrome version from PE metadata on Windows                             | XS   |             |
| [ ]       | P2       | #84280 | fix: handle SIGUSR1 restart on Windows where the signal is unsupported                    | S    |             |
| [ ]       | P2       | #80683 | fix(memory-lancedb): add retry mechanism for Windows Docker bind mount sync delays        | S    |             |
| [ ]       | P2       | #79694 | fix(update): hide post-core update and completion cache child windows on Windows          | XL   |             |
| [ ]       | P2       | #76245 | [codex] Fallback when Windows gateway task exits early                                    | S    |             |
| [ ]       | P2       | #75649 | fix(windows): preserve staged update handoff                                              | XL   |             |
| [ ]       | P2       | #74425 | fix: ensure CLI processes exit after command completion on Windows                        | S    |             |
| [ ]       | P2       | #73889 | fix(cli): stabilize Windows scheduled-task restart health after ready                     | S    |             |
| [ ]       | P2       | #73751 | fix(exec): decode Windows command output with codepage-aware streaming                    | M    |             |
| [ ]       | P2       | #70762 | refactor(agents): share hook history windows                                              | XL   | @vincentkoc |
| [ ]       | P2       | #68725 | feat(amazon-bedrock-mantle): add known context windows for open-weight Mantle models      | S    |             |
| [ ]       | P2       | #67655 | fix(exec): fail closed on Windows shell wrappers in allowlist mode                        | XS   |             |
| [ ]       | P2       | #64110 | feat: Deleting scheduled tasks also clears tasks in the queue.                            | L    |             |
| [ ]       | P2       | #59705 | [codex] improve parallels windows smoke logging                                           | M    |             |
| [ ]       | P2       | #59013 | fix: tolerate EPERM in session write-lock on Windows                                      | S    |             |
| [ ]       | P2       | #51486 | fix(daemon): query Windows task runtime directly                                          | S    |             |

---

## 5. WSL (Windows Subsystem for Linux) — Issues

### Bugs / Crashes

| Resolved? | Priority | #      | Title                                                                                                                                           | Labels                                                                                                                                                | Assignee |
| --------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [ ]       | P1       | #86752 | [Bug]: 2026.5.22 Docker/WSL2 gateway event-loop starvation, 284s provider-auth prewarm, slow Telegram turn, and local RPC timeouts              | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-live-repro` `impact:message-loss` `impact:auth-provider` +2 |          |
| [ ]       | P1       | #86048 | WSL2 GPU-PV driver lockup: nvidia-smi hangs after llama-server D-state crash                                                                    |                                                                                                                                                       |          |
| [ ]       | P1       | #85537 | Build fails resolving protobufjs google/protobuf descriptor on WSL source checkout                                                              | `maintainer` `P2` `clawsweeper:needs-live-repro` `impact:crash-loop` `issue-rating: 🐚 platinum hermit`                                               |          |
| [ ]       | P1       | #84610 | [Bug]: Gateway loops with SIGTERM every ~90s after upgrade 2026.4.23→2026.5.18 (WSL2). Inbound msg received but cli watchdog kills mid-response | `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-info` `impact:message-loss` `impact:crash-loop` +1          |          |
| [ ]       | P1       | #68966 | [Bug]: [WSL] openclaw browser command terminated by SIGKILL causing timeout                                                                     | `bug` `bug:crash` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-info` +2                                  |          |
| [ ]       | P1       | #61616 | [Bug]: [WSL2] Global 30-min gateway stall (:29/:59) affects Telegram + Control UI                                                               | `bug` `P1` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:needs-info` +3         |          |
| [ ]       | P2       | #88080 | WSL2: clipboard fails on execFile                                                                                                               | `P2` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:needs-live-repro` `issue-rating: 🐚 platinum hermit` `impact:other`       |          |
| [ ]       | P2       | #86314 | [Bug] openclaw-weixin channel not registered in gateway runtime - invalid channels.start channel on WSL2                                        |                                                                                                                                                       | @sliverp |
| [ ]       | P2       | #80336 | [Bug]: placeholder.openclaw.cloud unreachable on WSL2 with custom gateway port                                                                  | `bug` `bug:behavior`                                                                                                                                  |          |
| [ ]       | P2       | #73602 | [Bug]: WhatsApp flaps and Telegram polling stalls on WSL2 in 2026.4.26                                                                          |                                                                                                                                                       |          |
| [ ]       | P2       | #73152 | Docs/doctor request: clarify gateway reachability for OrbStack/WSL/VM/Tailscale setups                                                          |                                                                                                                                                       |          |

### Feature Requests

_No currently open items found._

---

## 6. WSL (Windows Subsystem for Linux) — PRs

| Resolved? | Priority | #      | Title                                                                            | Size | Assignee |
| --------- | -------- | ------ | -------------------------------------------------------------------------------- | ---- | -------- |
| [ ]       | P2       | #88089 | fix(clipboard): use shell-based clip.exe on WSL2                                 | XS   |          |
| [ ]       | P2       | #85711 | docs: add WSL build troubleshooting to CONTRIBUTING.md                           | XS   |          |
| [ ]       | P2       | #68400 | daemon/systemd: distinguish WSL user D-Bus socket missing from missing systemctl | S    |          |
| [ ]       | P2       | #58853 | feat(doctor): add WSL environment diagnostics check [AI-assisted]                | L    |          |

---

## 7. Azure (Provider / Infrastructure) — Issues

### Bugs / Crashes

| Resolved? | Priority | #      | Title                                                                                                                                | Labels                                                                                                                                                           | Assignee |
| --------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [ ]       | P1       | #88019 | [Bug]: Azure Responses session replay keeps msg id without required reasoning after fallback                                         | `P1` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:source-repro` `impact:session-state` `impact:auth-provider` +1                       |          |
| [ ]       | P1       | #87737 | DeepSeek V4 thinking wrapper ignores thinkingFormat compat override, breaks Azure Foundry deployments                                | `P1` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:source-repro` `impact:auth-provider` `issue-rating: 🦞 diamond lobster`              |          |
| [ ]       | P1       | #84109 | Azure AI Foundry Responses API: `type: "message"` missing from input items causes 400 error                                          | `P2` `clawsweeper:fix-shape-clear` `clawsweeper:queueable-fix` `clawsweeper:source-repro` `impact:auth-provider` `issue-rating: 🦞 diamond lobster`              |          |
| [ ]       | P1       | #60546 | [Bug]: microsoft-foundry provider selects Claude deployments but routes them through OpenAI Foundry endpoints                        | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:source-repro` `clawsweeper:linked-pr-open` `impact:auth-provider` `issue-rating: 🦞 diamond lobster`               |          |
| [ ]       | P1       | #48793 | feat: centralized PluginResourceManager interface for consistent async cleanup across all channel plugins                            | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `impact:crash-loop` +1 |          |
| [ ]       | P2       | #80926 | Azure OpenAI Responses stalls before first event when memory tools are exposed                                                       | `maintainer`                                                                                                                                                     |          |
| [ ]       | P2       | #79570 | openai-responses adapter is unusable against Azure OpenAI: every turn returns a synthetic 0-token refusal (openai-completions works) |                                                                                                                                                                  |          |
| [ ]       | P2       | #48788 | feat: centralized filename encoding utility for multi-encoding Content-Disposition handling                                          | `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:fix-shape-clear` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `impact:data-loss` +1  |          |

### Feature Requests

| Resolved? | Priority | #      | Title                                                                         | Labels                                                                                                                                                  | Assignee |
| --------- | -------- | ------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| [ ]       | P2       | #87325 | Support Azure Foundry GPT Realtime Talk via gateway relay                     |                                                                                                                                                         |          |
| [ ]       | P2       | #71058 | [Feature]: Support for multiple Azure/Teams bots on a single Openclaw Gateway | `enhancement` `P2` `clawsweeper:no-new-fix-pr` `clawsweeper:needs-maintainer-review` `clawsweeper:needs-product-decision` `clawsweeper:source-repro` +1 |          |

---

## 8. Azure (Provider / Infrastructure) — PRs

| Resolved? | Priority | #      | Title                                                 | Size | Assignee |
| --------- | -------- | ------ | ----------------------------------------------------- | ---- | -------- |
| [ ]       | P0       | #55395 | fix: centralize plugin command auth requirements      | M    |          |
| [ ]       | P2       | #70922 | refactor(whatsapp): centralize account policy         | L    |          |
| [ ]       | P2       | #55211 | fix: prevent re-entrant loop in internal hook trigger | M    |          |

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

| Category                  | Type  | Priority | #      | Title                                                                                                                                     |
| ------------------------- | ----- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| MS Teams (channel plugin) | pr    | P0       | #87296 | feat: group model select with collapsible panel in Control UI                                                                             |
| MS Teams (channel plugin) | pr    | P0       | #87202 | refactor: internalize OpenClaw agent runtime                                                                                              |
| MS Teams (channel plugin) | pr    | P0       | #85651 | feat(continuation): context-pressure-aware continuation (continue_work / continue_delegate / request_compaction)                          |
| MS Teams (channel plugin) | pr    | P0       | #81729 | Remove system event trust metadata                                                                                                        |
| MS Teams (channel plugin) | pr    | P0       | #81402 | refactor: move runtime state to SQLite                                                                                                    |
| MS Teams (channel plugin) | pr    | P0       | #77784 | Add Teams delegated auth for plugin tools                                                                                                 |
| MS Teams (channel plugin) | pr    | P0       | #70864 | feat: add scoped mention pattern policy                                                                                                   |
| MS Teams (channel plugin) | pr    | P0       | #67460 | feat(mention-gating): suppress always-on agent when another agent is explicitly mentioned                                                 |
| MS Teams (channel plugin) | pr    | P0       | #67174 | Teams: support separate graphTenantId for cross-tenant Graph API access                                                                   |
| MS Teams (channel plugin) | pr    | P0       | #60643 | feat(agents): cognitive processing scaffolding and structured memory prompt                                                               |
| MS Teams (channel plugin) | pr    | P0       | #57511 | feat(msteams): Teams live voice support with .NET media worker                                                                            |
| MS Teams (channel plugin) | pr    | P0       | #55828 | feat(msteams): add native plugin interactivity parity                                                                                     |
| MS Teams (channel plugin) | pr    | P0       | #55485 | Config: plumb opt-in SSRF policy for web fetch, citation redirects, and remote media                                                      |
| Windows platform          | issue | P0       | #57775 | Windows headless node host supports exec approvals via CLI, but nodes describe / Control UI do not advertise system.execApprovals.get/set |
| Windows platform          | issue | P0       | #48780 | [Bug]: [Windows] exec() and read() commands corrupted with </arg_value>> suffix                                                           |
| Windows platform          | issue | P0       | #75    | Linux/Windows Clawdbot Apps                                                                                                               |
| Windows platform          | pr    | P0       | #85264 | fix(infra): add global realpath cache to eliminate redundant lstat on Windows                                                             |
| Windows platform          | pr    | P0       | #81443 | fix: resolve QMD Windows shims and guard image URL downloads                                                                              |
| Windows platform          | pr    | P0       | #68819 | fix: resolve Windows .cmd shims to underlying .exe before spawn                                                                           |
| Windows platform          | pr    | P0       | #68149 | feat(daemon): use PowerShell Register-ScheduledTask for Windows auto-start                                                                |
| Windows platform          | pr    | P0       | #63651 | fix: remove duplicate restart message on Windows (schtasks)                                                                               |
| Azure                     | pr    | P0       | #55395 | fix: centralize plugin command auth requirements                                                                                          |

## Appendix: High-Priority Bugs / Regressions

| Category                  | Type  | Priority | #      | Title                                                                                                                                                   |
| ------------------------- | ----- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MS Teams (channel plugin) | issue | P1       | #85149 | [Bug]: msteams federated managed identity ignores FIC, leaks MI appid in outbound Bot Framework calls                                                   |
| MS Teams (channel plugin) | issue | P1       | #67177 | [msteams] Inbound file attachments silently fail in DMs — file.download.info downloadUrl not rewritten to Graph shares endpoint                         |
| MS Teams (channel plugin) | issue | P1       | #65329 | bug(msteams): DM inline images and file attachments silently dropped                                                                                    |
| MS Teams (channel plugin) | issue | P1       | #62765 | msteams dmPolicy=pairing silently drops unpaired senders with HTTP 200, no log line, no auto-reply                                                      |
| MS Teams (channel plugin) | pr    | P1       | #87169 | Support separate Teams Graph tenant                                                                                                                     |
| MS Teams (channel plugin) | pr    | P1       | #82253 | feat(slack): support per-channel replyToMode                                                                                                            |
| MS Teams (channel plugin) | pr    | P1       | #75043 | Add provider-aware automatic TTS emotion mapping                                                                                                        |
| Windows platform          | issue | P1       | #87993 | [Bug]: Windows — openclaw update 期间 Scheduled Task PT3M 重复触发器重新拉起 gateway 导致竞态                                                           |
| Windows platform          | issue | P1       | #87156 | [Bug]: Windows doctor update leaves Startup-folder gateway fallback stale and does not install Scheduled Task                                           |
| Windows platform          | issue | P1       | #87136 | compaction: absolute token thresholds break when switching models with different context windows                                                        |
| Windows platform          | issue | P1       | #86987 | [Bug]: [Regression] Gateway 5.18+ shows empty Caps for all node versions on Windows/Docker                                                              |
| Windows platform          | issue | P1       | #86599 | [Bug]: Local model provider calls thread block gateway event loop on Windows beta; trivial infer run takes ~4 minutes                                   |
| Windows platform          | issue | P1       | #86087 | [Bug]: [Beta][Windows] 2026.5.24-beta.1 Codex harness fails: removed plugin-sdk/codex-native-task-runtime export still imported by @openclaw/codex      |
| Windows platform          | issue | P1       | #86044 | 2026.5.22: CLI hangs on Windows — provider auth-state pre-warm blocks all CLI commands                                                                  |
| Windows platform          | issue | P1       | #86031 | [Bug]: Windows gateway listens but local health/status time out after Telegram polling stall (v2026.5.20)                                               |
| Windows platform          | issue | P1       | #85268 | [Bug]: [Windows] exec spawn: all commands hang with no output (stdio pipe deadlock)                                                                     |
| Windows platform          | issue | P1       | #84213 | [Bug]: openclaw completion -s zsh hangs on native Windows (no WSL)                                                                                      |
| Windows platform          | issue | P1       | #84203 | [Bug]: Windows — models.authStatus cold latency 10-24s per CLI session (2026.5.18 + Codex 0.131.0)                                                      |
| Windows platform          | issue | P1       | #84001 | Windows: openclaw status / status --json hangs in 2026.5.18 while status --all succeeds                                                                 |
| Windows platform          | issue | P1       | #83943 | [Bug]: Session resource loader grows unbounded across warm turns — 5.x regression vs 4.23 baseline (Windows + Feishu + MiniMax OAuth)                   |
| Windows platform          | issue | P1       | #83277 | WhatsApp channel: "web login provider is not available" on Windows despite wacli installed and authenticated                                            |
| Windows platform          | issue | P1       | #80416 | [Bug] core-plugin-tools ~3.5s overhead on every embedded run persists after #75520 fix — Windows + Node 24 + isolated cron jobs                         |
| Windows platform          | issue | P1       | #80344 | [Bug]: Discord voice /vc join fails on Windows with AggregateError + gateway heartbeat timeout / event loop starvation                                  |
| Windows platform          | issue | P1       | #79437 | Prebuilt `node-llama-cpp` Windows binaries crash (0xC0000005) on Intel Alder Lake-N (N95) — qmd LLM half unusable                                       |
| Windows platform          | issue | P1       | #77443 | [Bug]: WhatsApp event loop blocked (eventLoopDelayMaxMs=12088ms) on first inbound message — 2026.5.3-1 Windows                                          |
| Windows platform          | issue | P1       | #74378 | [Bug]: OpenClaw CLI commands remain alive as node.exe processes after execution on Windows                                                              |
| Windows platform          | issue | P1       | #71865 | Auth login blocked by size-drop guard when openclaw.json was created by PowerShell (verbose/BOM format)                                                 |
| Windows platform          | issue | P1       | #71717 | exec tool returns EPERM on Windows, all commands fail                                                                                                   |
| Windows platform          | issue | P1       | #71699 | [Bug]: Gateway hard-crashes with 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) on Windows during Mattermost streaming reply; auto-respawn frequently wedges  |
| Windows platform          | issue | P1       | #70788 | fix(windows): suppress startup-folder cmd window flash via wscript silent launcher                                                                      |
| Windows platform          | issue | P1       | #70451 | [Bug]: CLI hooks enable times out / SIGKILL on Windows                                                                                                  |
| Windows platform          | issue | P1       | #68493 | [Bug]: Editing openclaw.json while gateway is running triggers hot-reload crash loop on Windows (stale lock file + EADDRINUSE)                          |
| Windows platform          | issue | P1       | #67035 | [Bug]: 2026.4.14 Windows chat UI regression: input text swallowed, streamed replies often invisible until refresh, typing indicator flashes then blanks |
| Windows platform          | issue | P1       | #64253 | Gateway becomes unresponsive under subagent load on Windows - completion announcements timeout                                                          |
| Windows platform          | issue | P1       | #63491 | [Bug]: Windows Scheduled Task gateway restart/health becomes inconsistent after ready                                                                   |
| Windows platform          | issue | P1       | #63257 | Windows Gateway Feishu API timeout 30s at startup                                                                                                       |
| Windows platform          | issue | P1       | #62099 | EPERM on auth-profiles.json causes full gateway failure cascade (Windows)                                                                               |
| Windows platform          | issue | P1       | #59362 | [Bug]: Windows: exec tool causes console window flash when spawning commands                                                                            |
| Windows platform          | issue | P1       | #59281 | [Bug]: Windows plugin TS source-loading via jiti is pathologically slow in real production call sites                                                   |
| Windows platform          | issue | P1       | #54669 | [Field Report] Chrome 136+ binds CDP to [::1] (IPv6) on Windows — portproxy v4tov4 breaks silently                                                      |
| Windows platform          | issue | P1       | #44559 | [Bug]: Windows： Gateway 关闭 PowerShell 窗口后断连                                                                                                     |
| Windows platform          | issue | P1       | #40540 | [Bug]: `openclaw update` command fails with EBUSY error on Windows                                                                                      |
| Windows platform          | pr    | P1       | #69059 | fix: retry sqlite-vec load without .dll suffix on Windows                                                                                               |
| WSL                       | issue | P1       | #86752 | [Bug]: 2026.5.22 Docker/WSL2 gateway event-loop starvation, 284s provider-auth prewarm, slow Telegram turn, and local RPC timeouts                      |
| WSL                       | issue | P1       | #86048 | WSL2 GPU-PV driver lockup: nvidia-smi hangs after llama-server D-state crash                                                                            |
| WSL                       | issue | P1       | #85537 | Build fails resolving protobufjs google/protobuf descriptor on WSL source checkout                                                                      |
| WSL                       | issue | P1       | #84610 | [Bug]: Gateway loops with SIGTERM every ~90s after upgrade 2026.4.23→2026.5.18 (WSL2). Inbound msg received but cli watchdog kills mid-response         |
| WSL                       | issue | P1       | #68966 | [Bug]: [WSL] openclaw browser command terminated by SIGKILL causing timeout                                                                             |
| WSL                       | issue | P1       | #61616 | [Bug]: [WSL2] Global 30-min gateway stall (:29/:59) affects Telegram + Control UI                                                                       |
| Azure                     | issue | P1       | #88019 | [Bug]: Azure Responses session replay keeps msg id without required reasoning after fallback                                                            |
| Azure                     | issue | P1       | #87737 | DeepSeek V4 thinking wrapper ignores thinkingFormat compat override, breaks Azure Foundry deployments                                                   |
| Azure                     | issue | P1       | #84109 | Azure AI Foundry Responses API: `type: "message"` missing from input items causes 400 error                                                             |
| Azure                     | issue | P1       | #60546 | [Bug]: microsoft-foundry provider selects Claude deployments but routes them through OpenAI Foundry endpoints                                           |
| Azure                     | issue | P1       | #48793 | feat: centralized PluginResourceManager interface for consistent async cleanup across all channel plugins                                               |

## Appendix: Stale Items (Consider Closing)

_No matching items found._

## Audit Notes

- Rebuilt from the format of PR #49126 after the issue/PR purge.
- Source set is currently open GitHub issues and PRs from `openclaw/openclaw`; closed counts are intentionally reset to `0` for this refreshed tracker.
- Included title/label matches for `msteams`, Microsoft Teams, Windows, WSL, Azure, Entra/AAD, MSAL, managed identity, DefaultAzureCredential, Microsoft Graph, SharePoint, OneDrive, and Microsoft 365.
- Kept broad multi-channel PRs when they carry `channel: msteams`, because those can still affect the Microsoft surface area.
- Generated with `node scripts/generate-microsoft-tracker.mjs` so the tracker and PR body can be refreshed after future triage passes.
