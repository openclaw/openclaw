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
> **Last updated:** 2026-05-10 (post-purge audit: refreshed from currently open GitHub issues/PRs and rebuilt from PR #49126 format)

---

## Summary

| Category                  | Issues | PRs    | Total   | Closed | Remaining |
| ------------------------- | ------ | ------ | ------- | ------ | --------- |
| MS Teams (channel plugin) | 6      | 39     | 45      | 0      | 45        |
| Windows platform          | 66     | 39     | 105     | 0      | 105       |
| WSL                       | 9      | 5      | 14      | 0      | 14        |
| Azure                     | 5      | 6      | 11      | 0      | 11        |
| SharePoint / M365         | 0      | 0      | 0       | 0      | 0         |
| **Total**                 | **86** | **89** | **175** | **0**  | **175**   |

---

## 1. MS Teams Channel Plugin — Issues

### Bugs / Crashes

| Resolved? | Priority | #      | Title                                                                                                                           | Labels | Assignee |
| --------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- |
| [ ]       | P1       | #67177 | [msteams] Inbound file attachments silently fail in DMs — file.download.info downloadUrl not rewritten to Graph shares endpoint |        |          |
| [ ]       | P1       | #65329 | bug(msteams): DM inline images and file attachments silently dropped                                                            |        |          |
| [ ]       | P1       | #62765 | msteams dmPolicy=pairing silently drops unpaired senders with HTTP 200, no log line, no auto-reply                              |        |          |
| [ ]       | P2       | #66771 | [Bug]: MSTeams malformed mixed thread session key from old-session reselection                                                  |        |          |
| [ ]       | P2       | #42099 | fix(plugins): false-positive duplicate plugin ID warning on gateway start (msteams)                                             |        |          |

### Feature Requests

| Resolved? | Priority | #      | Title                                                                               | Labels | Assignee |
| --------- | -------- | ------ | ----------------------------------------------------------------------------------- | ------ | -------- |
| [ ]       | P2       | #71049 | feat(msteams): add option to disable Copilot-style informative stream status in DMs |        |          |

---

## 2. MS Teams Channel Plugin — PRs

| Resolved? | Priority | #      | Title                                                                                                | Size | Assignee    |
| --------- | -------- | ------ | ---------------------------------------------------------------------------------------------------- | ---- | ----------- |
| [ ]       | P0       | #79972 | feat: add SQLite transcript frontier and delta API                                                   | XL   |             |
| [ ]       | P0       | #79971 | fix: tighten SQLite runtime truth in session refactor                                                | XL   |             |
| [ ]       | P0       | #79970 | feat: expose durable session id match selection helpers                                              | XL   |             |
| [ ]       | P0       | #78595 | Refactor runtime state into SQLite                                                                   | XL   |             |
| [ ]       | P0       | #63827 | fix(security): preserve dmPolicy settings during wizard runs                                         | XL   |             |
| [ ]       | P1       | #79444 | [codex] refresh plugin regression fixtures                                                           | S    |             |
| [ ]       | P1       | #77784 | Add Teams delegated auth for plugin tools                                                            | XL   |             |
| [ ]       | P1       | #48014 | feat(msteams): add DefaultAzureCredential auth type for passwordless Teams auth                      | L    |             |
| [ ]       | P2       | #79609 | Show session cleanup dry-run counts by label                                                         | L    |             |
| [ ]       | P2       | #78850 | fix(msteams): make resolveMSTeamsRouteSessionKey idempotent against pre-suffixed bases (#66771)      | S    |             |
| [ ]       | P2       | #78839 | [codex] Add Teams member-info action gate                                                            | S    |             |
| [ ]       | P2       | #77921 | feat(inworld): default to inworld-tts-2 (Realtime TTS-2)                                             | XS   |             |
| [ ]       | P2       | #76560 | feat(plugins): allow community plugins to use openKeyedStore with man…                               | L    | @vincentkoc |
| [ ]       | P2       | #76262 | fix(msteams): rebase TeamsSDK patterns to simplify Teams Integration                                 | XL   | @BradGroux  |
| [ ]       | P2       | #75043 | Add provider-aware automatic TTS emotion mapping                                                     | L    |             |
| [ ]       | P2       | #70474 | Codex/pr69584 split                                                                                  | XL   |             |
| [ ]       | P2       | #70287 | fix(msteams): drop unsupported $search on msteams:search (AI-assisted)                               | M    |             |
| [ ]       | P2       | #69428 | fix(msteams): paginate thread replies and keep recent context                                        | S    |             |
| [ ]       | P2       | #67761 | fix: remove truncated preview from inbound system events                                             | XS   |             |
| [ ]       | P2       | #67460 | feat(mention-gating): suppress always-on agent when another agent is explicitly mentioned            | M    |             |
| [ ]       | P2       | #67174 | Teams: support separate graphTenantId for cross-tenant Graph API access                              | M    |             |
| [ ]       | P2       | #66327 | feat(msteams): implement sendPayload for interactive approval cards                                  | M    |             |
| [ ]       | P2       | #64503 | fix(msteams): forward messageBack card actions (Action.Submit) to agent (#60952)                     | S    |             |
| [ ]       | P2       | #63347 | feat(msteams): support webhook host binding                                                          | S    |             |
| [ ]       | P2       | #61498 | build(plugins): enforce extension package root boundaries                                            | XL   |             |
| [ ]       | P2       | #60643 | feat(agents): cognitive processing scaffolding and structured memory prompt                          | S    |             |
| [ ]       | P2       | #60630 | fix(ci): Windows task tests and Telegram setup promotion surface                                     | L    |             |
| [ ]       | P2       | #59986 | refactor(plugins): add lane-oriented channel interface                                               | XL   |             |
| [ ]       | P2       | #59485 | fix: preserve paperclip runtime env in exec tool defaults                                            | M    |             |
| [ ]       | P2       | #59314 | fix(msteams): preserve channel thread isolation during proactive fallback                            | M    |             |
| [ ]       | P2       | #59294 | fix(msteams): isolate thread sessions, outbound targeting, and attachment resolution                 | L    |             |
| [ ]       | P2       | #57511 | feat(msteams): Teams live voice support with .NET media worker                                       | XL   |             |
| [ ]       | P2       | #57366 | fix(msteams): extract emoji unicode from Teams CDN img tags instead of treating as image attachments | S    |             |
| [ ]       | P2       | #57364 | fix(msteams): delete FileConsentCard after user accepts, declines, or upload expires                 | S    |             |
| [ ]       | P2       | #55828 | feat(msteams): add native plugin interactivity parity                                                | XL   |             |
| [ ]       | P2       | #55485 | Config: plumb opt-in SSRF policy for web fetch, citation redirects, and remote media                 | L    |             |
| [ ]       | P2       | #50875 | feat: add before_identity_resolve plugin hook                                                        | M    |             |
| [ ]       | P2       | #43190 | MS Teams: add channel archive persistence and deleted-channel cleanup                                | XL   |             |
| [ ]       | P2       | #37656 | feat: load workspace .env per-agent at exec time                                                     | S    |             |

---

## 3. Windows Platform — Issues

### Bugs / Crashes

| Resolved? | Priority | #      | Title                                                                                                                                                     | Labels               | Assignee    |
| --------- | -------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------- |
| [ ]       | P0       | #74350 | [Security] Windows ACL audit bypass: Anonymous and Guest SIDs are misclassified as "group" instead of "world"                                             |                      |             |
| [ ]       | P1       | #79437 | Prebuilt `node-llama-cpp` Windows binaries crash (0xC0000005) on Intel Alder Lake-N (N95) — qmd LLM half unusable                                         |                      |             |
| [ ]       | P1       | #77734 | Gateway crashes every 3 minutes on Windows - CIAO PROBING CANCELLED (bonjour plugin)                                                                      | `bug` `bug:crash`    |             |
| [ ]       | P1       | #77443 | [Bug]: WhatsApp event loop blocked (eventLoopDelayMaxMs=12088ms) on first inbound message — 2026.5.3-1 Windows                                            | `bug` `regression`   |             |
| [ ]       | P1       | #76699 | 2026.5.x: Telegram media download broken - event loop saturation on Windows                                                                               |                      |             |
| [ ]       | P1       | #74378 | [Bug]: OpenClaw CLI commands remain alive as node.exe processes after execution on Windows                                                                | `bug` `regression`   |             |
| [ ]       | P1       | #73874 | Gateway HTTP/WS dispatch deadlock on Windows + Docker Desktop bind-mount setups (regression in 2026.4.24, persists in .25 and .26)                        |                      |             |
| [ ]       | P1       | #71865 | Auth login blocked by size-drop guard when openclaw.json was created by PowerShell (verbose/BOM format)                                                   |                      |             |
| [ ]       | P1       | #71699 | [Bug]: Gateway hard-crashes with 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) on Windows during Mattermost streaming reply; auto-respawn frequently wedges    |                      |             |
| [ ]       | P1       | #70856 | [Bug]: WhatsApp listener repeatedly disconnects/stalls on Windows, causing "No active WhatsApp Web listener" and missed messages                          | `bug` `regression`   |             |
| [ ]       | P1       | #70788 | fix(windows): suppress startup-folder cmd window flash via wscript silent launcher                                                                        |                      |             |
| [ ]       | P1       | #68493 | [Bug]: Editing openclaw.json while gateway is running triggers hot-reload crash loop on Windows (stale lock file + EADDRINUSE)                            |                      | @vincentkoc |
| [ ]       | P1       | #67035 | [Bug]: 2026.4.14 Windows chat UI regression: input text swallowed, streamed replies often invisible until refresh, typing indicator flashes then blanks   |                      |             |
| [ ]       | P1       | #63257 | Windows Gateway Feishu API timeout 30s at startup                                                                                                         |                      |             |
| [ ]       | P1       | #62099 | EPERM on auth-profiles.json causes full gateway failure cascade (Windows)                                                                                 |                      |             |
| [ ]       | P1       | #62055 | Windows: CLI crashes with stack overflow / heap OOM on v2026.4.5 (large ESM module graph exceeds V8 default stack)                                        |                      |             |
| [ ]       | P1       | #59362 | [Bug]: Windows: exec tool causes console window flash when spawning commands                                                                              | `bug` `regression`   |             |
| [ ]       | P1       | #54669 | [Field Report] Chrome 136+ binds CDP to [::1] (IPv6) on Windows — portproxy v4tov4 breaks silently                                                        |                      |             |
| [ ]       | P1       | #53947 | writeTextFileAtomic (sync) crashes with EPERM on Docker volumes mounted from Windows                                                                      |                      |             |
| [ ]       | P1       | #47643 | [Bug]: Persistent Telegram Channel Issues: Sync Failures, Loops, and Config Changes Not Applying on Windows                                               | `bug` `regression`   |             |
| [ ]       | P1       | #46378 | [Bug]: 安装配置界面windows会卡死                                                                                                                          | `bug` `regression`   |             |
| [ ]       | P1       | #42011 | [Bug]: Control UI chat can stay stuck on "Stop" after embedded run timeout on Windows                                                                     | `bug` `bug:crash`    |             |
| [ ]       | P2       | #79899 | DefaultResourceLoader.reload() blocks event loop for 12-15s on Windows due to synchronous filesystem scanning                                             |                      |             |
| [ ]       | P2       | #79099 | Windows gateway probe still reports unreachable while gateway health is OK on 2026.5.6                                                                    |                      |             |
| [ ]       | P2       | #78640 | fix(memory): EPERM on Windows persists after 64187 retry — needs copyFile/unlink fallback (was in closed PR 71611)                                        |                      |             |
| [ ]       | P2       | #78435 | [Bug]: `channels.slack.start-account` phase blocks event loop 5+ minutes while a model_call is in flight (Windows, 2026.5.4)                              |                      |             |
| [ ]       | P2       | #78352 | [Bug]: 16 Telegram bots on Windows cause event loop starvation up to 65s — 100% ELU, 90%+ CPU, control-plane RPC >100s                                    |                      |             |
| [ ]       | P2       | #77878 | [BUG] openclaw-weixin channel exits with ESM loader error on Windows + Node 24                                                                            |                      |             |
| [ ]       | P2       | #77805 | telegram bundled channel setup fails on Windows: plugin module path escapes plugin root or fails alias checks                                             |                      |             |
| [ ]       | P2       | #77745 | Bug: Feishu image/media download fails with EPERM on Windows due to @larksuiteoapi/node-sdk fsync and writeSavedMediaBuffer handle.sync()                 |                      |             |
| [ ]       | P2       | #77730 | [Bug]: file-transfer plugin nodeHostCommands not advertised by Windows node host on live handshake (2026.5.3-1)                                           |                      |             |
| [ ]       | P2       | #77263 | Windows: native hook relay bridge directory permission check blocks Codex harness                                                                         |                      |             |
| [ ]       | P2       | #76884 | [Bug]: OpenClaw on native Windows getting notably slower and slower with each new version???                                                              | `bug`                |             |
| [ ]       | P2       | #76702 | Windows + Feishu DM becomes very slow after upgrade to 2026.5.2; latency appears in agent/session processing, likely amplified by large session context   |                      |             |
| [ ]       | P2       | #76553 | [Bug]: Windows: Claude Code not detected by OpenClaw, Gateway in restart loop after PATH workaround                                                       | `bug` `bug:behavior` |             |
| [ ]       | P2       | #73859 | [Bug]: Built-in plugins (minimax, google, talk-voice) fail with RangeError: Maximum call stack size exceeded on Windows                                   |                      |             |
| [ ]       | P2       | #73323 | [Bug]: Gateway runtime degradation: pricing fetch 60s timeouts, Telegram polling stalls, slow RPC — chronic across 4.23/4.25/4.26 on Windows 11 + Node 24 | `bug`                |             |
| [ ]       | P2       | #73059 | [Bug]: Windows linked source install can skip Control UI auto-build through junction-launched scripts/ui.js                                               |                      |             |
| [ ]       | P2       | #72922 | [Bug]: Sluggish response time and unstable Web GUI and CLI on Windows Server 2022                                                                         | `bug`                |             |
| [ ]       | P2       | #71717 | exec tool returns EPERM on Windows, all commands fail                                                                                                     | `bug`                |             |
| [ ]       | P2       | #70451 | [Bug]: CLI hooks enable times out / SIGKILL on Windows                                                                                                    |                      |             |
| [ ]       | P2       | #66746 | [Bug] Windows memory indexing falls back to FTS-only in 2026.4.14 even though direct node:sqlite + sqlite-vec works                                       |                      |             |
| [ ]       | P2       | #66479 | Windows: skill not discovered due to UTF-8 BOM injected by PowerShell WriteAllText                                                                        |                      |             |
| [ ]       | P2       | #65164 | All outbound HTTP fails inside gateway process on Windows 10 + Node 22 (WebSocket works)                                                                  |                      |             |
| [ ]       | P2       | #64443 | OpenClaw chat interface causes very high WindowServer CPU on Intel Retina iMac                                                                            |                      |             |
| [ ]       | P2       | #64253 | Gateway becomes unresponsive under subagent load on Windows - completion announcements timeout                                                            |                      |             |
| [ ]       | P2       | #63491 | [Bug]: Windows Scheduled Task gateway restart/health becomes inconsistent after ready                                                                     |                      |             |
| [ ]       | P2       | #59709 | Cron scheduled task delivery fails (v2026.3.31)                                                                                                           |                      |             |
| [ ]       | P2       | #59281 | [Bug]: Windows plugin TS source-loading via jiti is pathologically slow in real production call sites                                                     | `bug` `bug:behavior` |             |
| [ ]       | P2       | #58433 | [Bug]: [Windows] Path character loss bug - "system" becomes "ystem" in file paths                                                                         | `bug` `bug:behavior` |             |
| [ ]       | P2       | #58139 | [Bug]: memory-lancedb plugin fails with Windows Docker bind mount                                                                                         | `bug` `bug:behavior` |             |
| [ ]       | P2       | #56284 | Windows: gateway restart does not wait for active tasks and loses session state                                                                           |                      |             |
| [ ]       | P2       | #56106 | Transcript JSONL encoding corrupted on Windows (GBK/UTF-8 mix)                                                                                            |                      |             |
| [ ]       | P2       | #48780 | [Bug]: [Windows] exec() and read() commands corrupted with </arg_value>> suffix                                                                           | `bug` `bug:behavior` |             |
| [ ]       | P2       | #44559 | [Bug]: Windows： Gateway 关闭 PowerShell 窗口后断连                                                                                                       | `bug` `bug:behavior` |             |
| [ ]       | P2       | #44296 | Show the actual PowerShell profile path during onboarding shell-completion setup                                                                          |                      |             |
| [ ]       | P2       | #44293 | Make `pnpm check:docs` work in native PowerShell                                                                                                          |                      |             |
| [ ]       | P2       | #44291 | Add native PowerShell smoke coverage for contributor commands                                                                                             |                      |             |
| [ ]       | P2       | #40694 | Browser-opened temporary tabs/windows should close automatically after task completion                                                                    |                      |             |
| [ ]       | P2       | #40540 | [Bug]: `openclaw update` command fails with EBUSY error on Windows                                                                                        | `bug` `bug:behavior` |             |

### Feature Requests

| Resolved? | Priority | #      | Title                                                                                                                                     | Labels                      | Assignee |
| --------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------- |
| [ ]       | P2       | #72595 | [Feature]: Feishu channel needs per-channel proxy bypass for mixed Windows proxy setups                                                   | `enhancement`               |          |
| [ ]       | P2       | #57775 | Windows headless node host supports exec approvals via CLI, but nodes describe / Control UI do not advertise system.execApprovals.get/set |                             |          |
| [ ]       | P2       | #46590 | Feature Request: Add `cron` field to Agent configuration for Agent-owned scheduled tasks                                                  |                             |          |
| [ ]       | P2       | #18985 | [Feature]: Supports Windows 11 MSYS environment and Fishshell.                                                                            | `enhancement`               |          |
| [ ]       | P2       | #7057  | Flaky tests on Windows/WSL: timeouts and ENOENT in pi-tools workspace-paths & safe-bins                                                   | `enhancement`               |          |
| [ ]       | P2       | #75    | Linux/Windows Clawdbot Apps                                                                                                               | `enhancement` `help wanted` |          |

---

## 4. Windows Platform — PRs

| Resolved? | Priority | #      | Title                                                                                | Size | Assignee    |
| --------- | -------- | ------ | ------------------------------------------------------------------------------------ | ---- | ----------- |
| [ ]       | P0       | #74383 | fix(security): classify broad Windows SIDs as world principals                       | S    |             |
| [ ]       | P0       | #63074 | fix(security): classify dangerous Windows sandbox binds first                        | M    |             |
| [ ]       | P0       | #38846 | security(windows): enhance command argument validation                               | S    |             |
| [ ]       | P2       | #79694 | fix(update): hide post-core update and completion cache child windows on Windows     | XS   |             |
| [ ]       | P2       | #76245 | [codex] Fallback when Windows gateway task exits early                               | S    |             |
| [ ]       | P2       | #75649 | fix(windows): preserve staged update handoff                                         | XL   |             |
| [ ]       | P2       | #74425 | fix: ensure CLI processes exit after command completion on Windows                   | S    |             |
| [ ]       | P2       | #73889 | fix(cli): stabilize Windows scheduled-task restart health after ready                | S    |             |
| [ ]       | P2       | #73751 | fix(exec): decode Windows command output with codepage-aware streaming               | M    |             |
| [ ]       | P2       | #73674 | fix(memory): resolve QMD Windows cmd shims                                           | M    |             |
| [ ]       | P2       | #70762 | refactor(agents): share hook history windows                                         | XL   | @vincentkoc |
| [ ]       | P2       | #70341 | fix(exec): resolve Windows PowerShell cmdlet allowlist miss                          | M    |             |
| [ ]       | P2       | #69059 | fix: retry sqlite-vec load without .dll suffix on Windows                            | S    |             |
| [ ]       | P2       | #68819 | fix: resolve Windows .cmd shims to underlying .exe before spawn                      | M    |             |
| [ ]       | P2       | #68725 | feat(amazon-bedrock-mantle): add known context windows for open-weight Mantle models | S    |             |
| [ ]       | P2       | #68149 | feat(daemon): use PowerShell Register-ScheduledTask for Windows auto-start           | M    |             |
| [ ]       | P2       | #67655 | fix(exec): fail closed on Windows shell wrappers in allowlist mode                   | XS   |             |
| [ ]       | P2       | #64110 | feat: Deleting scheduled tasks also clears tasks in the queue.                       | L    |             |
| [ ]       | P2       | #63651 | fix: remove duplicate restart message on Windows (schtasks)                          | S    |             |
| [ ]       | P2       | #60678 | fix(acpx): add windowsHide to MCP proxy spawn on Windows                             | XS   |             |
| [ ]       | P2       | #59705 | [codex] improve parallels windows smoke logging                                      | M    |             |
| [ ]       | P2       | #59013 | fix: tolerate EPERM in session write-lock on Windows                                 | S    |             |
| [ ]       | P2       | #53965 | fix: atomic file writes on Windows-mounted Docker volumes                            | XS   |             |
| [ ]       | P2       | #52989 | fix: use pathToFileURL for Windows path comparison in generate-base-config-schema    | XS   |             |
| [ ]       | P2       | #52487 | fix(windows): prevent restart race from duplicate schtasks /Run                      | XS   |             |
| [ ]       | P2       | #52200 | fix(skills): normalize backslashes in compacted skill paths on Windows               | XS   |             |
| [ ]       | P2       | #51486 | fix(daemon): query Windows task runtime directly                                     | S    |             |
| [ ]       | P2       | #50136 | fix(windows): stabilize gateway restart and avoid false stale cleanup [AI-assisted]  | M    |             |
| [ ]       | P2       | #50116 | fix: handle Windows-style session paths when running on POSIX                        | XS   |             |
| [ ]       | P2       | #48887 | Fix/docs format check windows clean                                                  | M    |             |
| [ ]       | P2       | #48130 | fix: correct Windows Chrome executable path extraction regex                         | XS   |             |
| [ ]       | P2       | #46956 | feat(cli): add trust windows for time-bounded exec approval                          | XL   |             |
| [ ]       | P2       | #45870 | fix: align windows path tests with runtime behavior                                  | S    |             |
| [ ]       | P2       | #45380 | Make env-prefixed npm scripts work on Windows                                        | S    |             |
| [ ]       | P2       | #44228 | fix(reply): normalize Windows media paths for dedupe                                 | XS   |             |
| [ ]       | P2       | #44215 | fix(path): add Windows PATH bootstrap dirs                                           | S    |             |
| [ ]       | P2       | #42131 | fix(doctor): case-insensitive safe-bin trusted dir matching on macOS/Windows         | S    |             |
| [ ]       | P2       | #39644 | fix(windows): PowerShell completion install and time-format detection                | S    |             |
| [ ]       | P2       | #38932 | docs(gateway): add Windows no-Docker hardening fallback guide                        | XS   |             |

---

## 5. WSL (Windows Subsystem for Linux) — Issues

### Bugs / Crashes

| Resolved? | Priority | #      | Title                                                                                                                                        | Labels             | Assignee |
| --------- | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------- |
| [ ]       | P1       | #74251 | [Bug]: [Bug]: npm install -g openclaw@latest crashes with V8 Fatal error in WSL2 Ubuntu 24.04                                                | `bug`              |          |
| [ ]       | P1       | #68966 | [Bug]: [WSL] openclaw browser command terminated by SIGKILL causing timeout                                                                  | `bug` `bug:crash`  |          |
| [ ]       | P1       | #59209 | Misleading CDP "Empty reply from server" in WSL2 caused by portproxy self-loop (svchost/iphlpsvc), not Chrome                                | `bug` `regression` |          |
| [ ]       | P1       | #44051 | [Bug]: [skills] Skipping skill path error triggered on officially installed skills via clawhub (WSL Environment)                             | `bug` `regression` |          |
| [ ]       | P2       | #78222 | OpenClaw 2026.5.4 Gateway status/health inconsistency on WSL2: diagnostics report ok/listener, external checks show no listener and HTTP 000 |                    |          |
| [ ]       | P2       | #73602 | [Bug]: WhatsApp flaps and Telegram polling stalls on WSL2 in 2026.4.26                                                                       |                    |          |
| [ ]       | P2       | #73152 | Docs/doctor request: clarify gateway reachability for OrbStack/WSL/VM/Tailscale setups                                                       |                    |          |
| [ ]       | P2       | #61616 | [Bug]: [WSL2] Global 30-min gateway stall (:29/:59) affects Telegram + Control UI                                                            | `bug`              |          |

### Feature Requests

| Resolved? | Priority | #      | Title                                                                                                        | Labels        | Assignee |
| --------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------ | ------------- | -------- |
| [ ]       | P1       | #67060 | [Feature]: Provider requests ignore env proxy by default → causes silent timeout in WSL / proxy environments | `enhancement` |          |

---

## 6. WSL (Windows Subsystem for Linux) — PRs

| Resolved? | Priority | #      | Title                                                                                                               | Size | Assignee |
| --------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------- | ---- | -------- |
| [ ]       | P1       | #46698 | fix(auth): fix GitHub device flow polling and add --wait flag for WSL…                                              | S    |          |
| [ ]       | P2       | #68400 | daemon/systemd: distinguish WSL user D-Bus socket missing from missing systemctl                                    | S    |          |
| [ ]       | P2       | #59219 | fix[Bug]: [skills] Skipping skill path error triggered on officially installed skills via clawhub (WSL Environment) | M    |          |
| [ ]       | P2       | #58853 | feat(doctor): add WSL environment diagnostics check [AI-assisted]                                                   | L    |          |
| [ ]       | P2       | #44129 | fix(skills): exempt managed skills from path escaping checks on WSL (#44051)                                        | S    |          |

---

## 7. Azure (Provider / Infrastructure) — Issues

### Bugs / Crashes

| Resolved? | Priority | #      | Title                                                                                                                                | Labels | Assignee |
| --------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------ | -------- |
| [ ]       | P2       | #79570 | openai-responses adapter is unusable against Azure OpenAI: every turn returns a synthetic 0-token refusal (openai-completions works) |        |          |
| [ ]       | P2       | #60546 | [Bug]: microsoft-foundry provider selects Claude deployments but routes them through OpenAI Foundry endpoints                        |        |          |
| [ ]       | P2       | #48793 | feat: centralized PluginResourceManager interface for consistent async cleanup across all channel plugins                            |        |          |
| [ ]       | P2       | #48788 | feat: centralized filename encoding utility for multi-encoding Content-Disposition handling                                          |        |          |

### Feature Requests

| Resolved? | Priority | #      | Title                                                                         | Labels        | Assignee |
| --------- | -------- | ------ | ----------------------------------------------------------------------------- | ------------- | -------- |
| [ ]       | P2       | #71058 | [Feature]: Support for multiple Azure/Teams bots on a single Openclaw Gateway | `enhancement` |          |

---

## 8. Azure (Provider / Infrastructure) — PRs

| Resolved? | Priority | #      | Title                                                        | Size | Assignee |
| --------- | -------- | ------ | ------------------------------------------------------------ | ---- | -------- |
| [ ]       | P1       | #55395 | fix: centralize plugin command auth requirements             | M    |          |
| [ ]       | P2       | #70922 | refactor(whatsapp): centralize account policy                | L    |          |
| [ ]       | P2       | #56705 | Config: centralize known plugin ID resolution for validation | M    |          |
| [ ]       | P2       | #55211 | fix: prevent re-entrant loop in internal hook trigger        | S    |          |
| [ ]       | P2       | #47285 | feat(memory-lancedb): native Azure OpenAI support            | S    |          |
| [ ]       | P2       | #47181 | feat: add Azure Claude (AI Foundry) onboarding path          | L    |          |

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

| Category                  | Type  | Priority | #      | Title                                                                                                         |
| ------------------------- | ----- | -------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| MS Teams (channel plugin) | pr    | P0       | #79972 | feat: add SQLite transcript frontier and delta API                                                            |
| MS Teams (channel plugin) | pr    | P0       | #79971 | fix: tighten SQLite runtime truth in session refactor                                                         |
| MS Teams (channel plugin) | pr    | P0       | #79970 | feat: expose durable session id match selection helpers                                                       |
| MS Teams (channel plugin) | pr    | P0       | #78595 | Refactor runtime state into SQLite                                                                            |
| MS Teams (channel plugin) | pr    | P0       | #63827 | fix(security): preserve dmPolicy settings during wizard runs                                                  |
| Windows platform          | issue | P0       | #74350 | [Security] Windows ACL audit bypass: Anonymous and Guest SIDs are misclassified as "group" instead of "world" |
| Windows platform          | pr    | P0       | #74383 | fix(security): classify broad Windows SIDs as world principals                                                |
| Windows platform          | pr    | P0       | #63074 | fix(security): classify dangerous Windows sandbox binds first                                                 |
| Windows platform          | pr    | P0       | #38846 | security(windows): enhance command argument validation                                                        |

## Appendix: High-Priority Bugs / Regressions

| Category                  | Type  | Priority | #      | Title                                                                                                                                                   |
| ------------------------- | ----- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MS Teams (channel plugin) | issue | P1       | #67177 | [msteams] Inbound file attachments silently fail in DMs — file.download.info downloadUrl not rewritten to Graph shares endpoint                         |
| MS Teams (channel plugin) | issue | P1       | #65329 | bug(msteams): DM inline images and file attachments silently dropped                                                                                    |
| MS Teams (channel plugin) | issue | P1       | #62765 | msteams dmPolicy=pairing silently drops unpaired senders with HTTP 200, no log line, no auto-reply                                                      |
| MS Teams (channel plugin) | pr    | P1       | #79444 | [codex] refresh plugin regression fixtures                                                                                                              |
| MS Teams (channel plugin) | pr    | P1       | #77784 | Add Teams delegated auth for plugin tools                                                                                                               |
| MS Teams (channel plugin) | pr    | P1       | #48014 | feat(msteams): add DefaultAzureCredential auth type for passwordless Teams auth                                                                         |
| Windows platform          | issue | P1       | #79437 | Prebuilt `node-llama-cpp` Windows binaries crash (0xC0000005) on Intel Alder Lake-N (N95) — qmd LLM half unusable                                       |
| Windows platform          | issue | P1       | #77734 | Gateway crashes every 3 minutes on Windows - CIAO PROBING CANCELLED (bonjour plugin)                                                                    |
| Windows platform          | issue | P1       | #77443 | [Bug]: WhatsApp event loop blocked (eventLoopDelayMaxMs=12088ms) on first inbound message — 2026.5.3-1 Windows                                          |
| Windows platform          | issue | P1       | #76699 | 2026.5.x: Telegram media download broken - event loop saturation on Windows                                                                             |
| Windows platform          | issue | P1       | #74378 | [Bug]: OpenClaw CLI commands remain alive as node.exe processes after execution on Windows                                                              |
| Windows platform          | issue | P1       | #73874 | Gateway HTTP/WS dispatch deadlock on Windows + Docker Desktop bind-mount setups (regression in 2026.4.24, persists in .25 and .26)                      |
| Windows platform          | issue | P1       | #71865 | Auth login blocked by size-drop guard when openclaw.json was created by PowerShell (verbose/BOM format)                                                 |
| Windows platform          | issue | P1       | #71699 | [Bug]: Gateway hard-crashes with 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) on Windows during Mattermost streaming reply; auto-respawn frequently wedges  |
| Windows platform          | issue | P1       | #70856 | [Bug]: WhatsApp listener repeatedly disconnects/stalls on Windows, causing "No active WhatsApp Web listener" and missed messages                        |
| Windows platform          | issue | P1       | #70788 | fix(windows): suppress startup-folder cmd window flash via wscript silent launcher                                                                      |
| Windows platform          | issue | P1       | #68493 | [Bug]: Editing openclaw.json while gateway is running triggers hot-reload crash loop on Windows (stale lock file + EADDRINUSE)                          |
| Windows platform          | issue | P1       | #67035 | [Bug]: 2026.4.14 Windows chat UI regression: input text swallowed, streamed replies often invisible until refresh, typing indicator flashes then blanks |
| Windows platform          | issue | P1       | #63257 | Windows Gateway Feishu API timeout 30s at startup                                                                                                       |
| Windows platform          | issue | P1       | #62099 | EPERM on auth-profiles.json causes full gateway failure cascade (Windows)                                                                               |
| Windows platform          | issue | P1       | #62055 | Windows: CLI crashes with stack overflow / heap OOM on v2026.4.5 (large ESM module graph exceeds V8 default stack)                                      |
| Windows platform          | issue | P1       | #59362 | [Bug]: Windows: exec tool causes console window flash when spawning commands                                                                            |
| Windows platform          | issue | P1       | #54669 | [Field Report] Chrome 136+ binds CDP to [::1] (IPv6) on Windows — portproxy v4tov4 breaks silently                                                      |
| Windows platform          | issue | P1       | #53947 | writeTextFileAtomic (sync) crashes with EPERM on Docker volumes mounted from Windows                                                                    |
| Windows platform          | issue | P1       | #47643 | [Bug]: Persistent Telegram Channel Issues: Sync Failures, Loops, and Config Changes Not Applying on Windows                                             |
| Windows platform          | issue | P1       | #46378 | [Bug]: 安装配置界面windows会卡死                                                                                                                        |
| Windows platform          | issue | P1       | #42011 | [Bug]: Control UI chat can stay stuck on "Stop" after embedded run timeout on Windows                                                                   |
| WSL                       | issue | P1       | #74251 | [Bug]: [Bug]: npm install -g openclaw@latest crashes with V8 Fatal error in WSL2 Ubuntu 24.04                                                           |
| WSL                       | issue | P1       | #68966 | [Bug]: [WSL] openclaw browser command terminated by SIGKILL causing timeout                                                                             |
| WSL                       | issue | P1       | #67060 | [Feature]: Provider requests ignore env proxy by default → causes silent timeout in WSL / proxy environments                                            |
| WSL                       | issue | P1       | #59209 | Misleading CDP "Empty reply from server" in WSL2 caused by portproxy self-loop (svchost/iphlpsvc), not Chrome                                           |
| WSL                       | issue | P1       | #44051 | [Bug]: [skills] Skipping skill path error triggered on officially installed skills via clawhub (WSL Environment)                                        |
| WSL                       | pr    | P1       | #46698 | fix(auth): fix GitHub device flow polling and add --wait flag for WSL…                                                                                  |
| Azure                     | pr    | P1       | #55395 | fix: centralize plugin command auth requirements                                                                                                        |

## Appendix: Stale Items (Consider Closing)

_No matching items found._

## Audit Notes

- Rebuilt from the format of PR #49126 after the issue/PR purge.
- Source set is currently open GitHub issues and PRs from `openclaw/openclaw`; closed counts are intentionally reset to `0` for this refreshed tracker.
- Included title/label matches for `msteams`, Microsoft Teams, Windows, WSL, Azure, Entra/AAD, MSAL, managed identity, DefaultAzureCredential, Microsoft Graph, SharePoint, OneDrive, and Microsoft 365.
- Kept broad multi-channel PRs when they carry `channel: msteams`, because those can still affect the Microsoft surface area.
- Generated with `node scripts/generate-microsoft-tracker.mjs` so the tracker and PR body can be refreshed after future triage passes.
