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
> **Last updated:** 2026-04-29 (post-purge audit: refreshed from currently open GitHub issues/PRs and rebuilt from PR #49126 format)

---

## Summary

| Category | Issues | PRs | Total | Closed | Remaining |
| -------- | ------ | --- | ----- | ------ | --------- |
| MS Teams (channel plugin) | 9 | 41 | 50 | 0 | 50 |
| Windows platform | 54 | 51 | 105 | 0 | 105 |
| WSL | 11 | 8 | 19 | 0 | 19 |
| Azure | 6 | 9 | 15 | 0 | 15 |
| SharePoint / M365 | 0 | 0 | 0 | 0 | 0 |
| **Total** | **80** | **109** | **189** | **0** | **189** |

---

## 1. MS Teams Channel Plugin — Issues

### Bugs / Crashes

| Resolved? | Priority | # | Title | Labels | Assignee |
| --------- | -------- | - | ----- | ------ | -------- |
| [ ] | P1 | #73754 | msteams: v2026.4.26 ships broken JWT validator (jwt.verify is not a function); fix b3bc60ae missed the cut |  |  |
| [ ] | P1 | #67659 | [Bug]: MS Teams delegated OAuth launcher uses xdg-open on win32 instead of explorer.exe |  |  |
| [ ] | P1 | #67177 | [msteams] Inbound file attachments silently fail in DMs — file.download.info downloadUrl not rewritten to Graph shares endpoint |  |  |
| [ ] | P1 | #65329 | bug(msteams): DM inline images and file attachments silently dropped |  |  |
| [ ] | P1 | #62765 | msteams dmPolicy=pairing silently drops unpaired senders with HTTP 200, no log line, no auto-reply |  |  |
| [ ] | P2 | #66771 | [Bug]: MSTeams malformed mixed thread session key from old-session reselection |  |  |
| [ ] | P2 | #52558 | pnpm check fails on main with tsgo errors in irc/mattermost/msteams/nextcloud-talk | `maintainer` |  |
| [ ] | P2 | #42099 | fix(plugins): false-positive duplicate plugin ID warning on gateway start (msteams) |  |  |

### Feature Requests

| Resolved? | Priority | # | Title | Labels | Assignee |
| --------- | -------- | - | ----- | ------ | -------- |
| [ ] | P2 | #71049 | feat(msteams): add option to disable Copilot-style informative stream status in DMs |  |  |

---

## 2. MS Teams Channel Plugin — PRs

| Resolved? | Priority | # | Title | Size | Assignee |
| --------- | -------- | - | ----- | ---- | -------- |
| [ ] | P0 | #73590 | feat: add tool-scoped hooks and fork guard | XL |  |
| [ ] | P0 | #68077 | fix: MS Teams OAuth on Windows and browser.cdpUrl security redaction | XS |  |
| [ ] | P0 | #63827 | fix(security): preserve dmPolicy settings during wizard runs | XL |  |
| [ ] | P1 | #67660 | fix(msteams): use explorer.exe for delegated OAuth on win32 | S |  |
| [ ] | P1 | #54803 | /status: show usage fetch errors instead of silently hiding | XL |  |
| [ ] | P1 | #48014 | feat(msteams): add DefaultAzureCredential auth type for passwordless Teams auth | L |  |
| [ ] | P2 | #73456 | feat(azure-speech): add realtime transcription provider for voice-call | XL |  |
| [ ] | P2 | #70474 | Codex/pr69584 split | XL |  |
| [ ] | P2 | #70287 | fix(msteams): drop unsupported $search on msteams:search (AI-assisted) | M |  |
| [ ] | P2 | #69428 | fix(msteams): paginate thread replies and keep recent context | S |  |
| [ ] | P2 | #67761 | fix: remove truncated preview from inbound system events | XS |  |
| [ ] | P2 | #67460 | feat(mention-gating): suppress always-on agent when another agent is explicitly mentioned | M |  |
| [ ] | P2 | #67174 | Teams: support separate graphTenantId for cross-tenant Graph API access | M |  |
| [ ] | P2 | #66327 | feat(msteams): implement sendPayload for interactive approval cards | M |  |
| [ ] | P2 | #66210 | feat(msteams): add thread copilot approvals | XL |  |
| [ ] | P2 | #64503 | fix(msteams): forward messageBack card actions (Action.Submit) to agent (#60952) | S |  |
| [ ] | P2 | #63347 | feat(msteams): support webhook host binding | S |  |
| [ ] | P2 | #61498 | build(plugins): enforce extension package root boundaries | XL |  |
| [ ] | P2 | #60643 | feat(agents): cognitive processing scaffolding and structured memory prompt | S |  |
| [ ] | P2 | #60630 | fix(ci): Windows task tests and Telegram setup promotion surface | L |  |
| [ ] | P2 | #59986 | refactor(plugins): add lane-oriented channel interface | XL |  |
| [ ] | P2 | #59485 | fix: preserve paperclip runtime env in exec tool defaults | M |  |
| [ ] | P2 | #59314 | fix(msteams): preserve channel thread isolation during proactive fallback | M |  |
| [ ] | P2 | #59294 | fix(msteams): isolate thread sessions, outbound targeting, and attachment resolution | L |  |
| [ ] | P2 | #59223 | fix(ms teams): preserve proactive conversation payload | M |  |
| [ ] | P2 | #57511 | feat(msteams): Teams live voice support with .NET media worker | XL |  |
| [ ] | P2 | #57366 | fix(msteams): extract emoji unicode from Teams CDN img tags instead of treating as image attachments | S |  |
| [ ] | P2 | #57364 | fix(msteams): delete FileConsentCard after user accepts, declines, or upload expires | S |  |
| [ ] | P2 | #55828 | feat(msteams): add native plugin interactivity parity | XL |  |
| [ ] | P2 | #55485 | Config: plumb opt-in SSRF policy for web fetch, citation redirects, and remote media | L |  |
| [ ] | P2 | #55458 | Status: surface memory probe errors instead of hiding them | XL |  |
| [ ] | P2 | #51570 | Add OpenClaw User-Agent header to all outbound HTTP requests | S | @SidU |
| [ ] | P2 | #50875 | feat: add before_identity_resolve plugin hook | M |  |
| [ ] | P2 | #46303 | fix: drain inbound debounce buffer and followup queues before SIGUSR1 reload | XL |  |
| [ ] | P2 | #43190 | MS Teams: add channel archive persistence and deleted-channel cleanup | XL |  |
| [ ] | P2 | #42400 | feat(channels): add neverReply config for group message suppression | L |  |
| [ ] | P2 | #40463 | fix(msteams): fix image attachment download for channel and DM messages | S | @BradGroux |
| [ ] | P2 | #37656 | feat: load workspace .env per-agent at exec time | M |  |
| [ ] | P2 | #34581 | fix(msteams): handle invalid JSON escape sequences in Bot Framework activities | M | @BradGroux |
| [ ] | P2 | #32558 | MSTeams: add upload session fallback for large files | M | @BradGroux |
| [ ] | P2 | #30142 | feat(adapters): add sendPayload to batch-b (Discord, Google Chat, Mattermost, MS Teams, Slack, Synology) | L | @BradGroux |

---

## 3. Windows Platform — Issues

### Bugs / Crashes

| Resolved? | Priority | # | Title | Labels | Assignee |
| --------- | -------- | - | ----- | ------ | -------- |
| [ ] | P1 | #74086 | [Bug]: Regression: Telegram provider fails on Windows after 2026.4.23 (deleteWebhook / setMyCommands errors) | `bug` `regression` |  |
| [ ] | P1 | #73874 | Gateway HTTP/WS dispatch deadlock on Windows + Docker Desktop bind-mount setups (regression in 2026.4.24, persists in .25 and .26) |  |  |
| [ ] | P1 | #71865 | Auth login blocked by size-drop guard when openclaw.json was created by PowerShell (verbose/BOM format) |  |  |
| [ ] | P1 | #71699 | [Bug]: Gateway hard-crashes with 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) on Windows during Mattermost streaming reply; auto-respawn frequently wedges |  |  |
| [ ] | P1 | #70857 | [Bug]: Windows startup and reply latency, session lock held for 191s on sessions.json.lock | `bug` `regression` |  |
| [ ] | P1 | #70856 | [Bug]: WhatsApp listener repeatedly disconnects/stalls on Windows, causing "No active WhatsApp Web listener" and missed messages | `bug` `regression` |  |
| [ ] | P1 | #70788 | fix(windows): suppress startup-folder cmd window flash via wscript silent launcher |  |  |
| [ ] | P1 | #68656 | Slow startup on Windows (~39s before ready) with long silent gap before plugin registration | `bug` `regression` | @galiniliev |
| [ ] | P1 | #68493 | [Bug]: Editing openclaw.json while gateway is running triggers hot-reload crash loop on Windows (stale lock file + EADDRINUSE) |  | @vincentkoc |
| [ ] | P1 | #67035 | [Bug]: 2026.4.14 Windows chat UI regression: input text swallowed, streamed replies often invisible until refresh, typing indicator flashes then blanks |  |  |
| [ ] | P1 | #63257 | Windows Gateway Feishu API timeout 30s at startup |  |  |
| [ ] | P1 | #62099 | EPERM on auth-profiles.json causes full gateway failure cascade (Windows) |  |  |
| [ ] | P1 | #62055 | Windows: CLI crashes with stack overflow / heap OOM on v2026.4.5 (large ESM module graph exceeds V8 default stack) |  |  |
| [ ] | P1 | #59362 | [Bug]: Windows: exec tool causes console window flash when spawning commands | `bug` `regression` |  |
| [ ] | P1 | #54669 | [Field Report] Chrome 136+ binds CDP to [::1] (IPv6) on Windows — portproxy v4tov4 breaks silently |  |  |
| [ ] | P1 | #54470 | [Bug]:  openclaw webhooks gmail setup fails on native Windows with `Error: spawn gcloud ENOENT` | `bug` `bug:crash` |  |
| [ ] | P1 | #47643 | [Bug]: Persistent Telegram Channel Issues: Sync Failures, Loops, and Config Changes Not Applying on Windows | `bug` `stale` `regression` |  |
| [ ] | P1 | #46378 | [Bug]: 安装配置界面windows会卡死 | `bug` `stale` `regression` |  |
| [ ] | P1 | #42011 | [Bug]: Control UI chat can stay stuck on "Stop" after embedded run timeout on Windows | `bug` `bug:crash` |  |
| [ ] | P1 | #39038 | [Bug]: OpenClaw节点程序在Windows 11 24H2上启动后卡在PATH信息，无法连接Gateway | `bug` `bug:crash` |  |
| [ ] | P2 | #73859 | [Bug]: Built-in plugins (minimax, google, talk-voice) fail with RangeError: Maximum call stack size exceeded on Windows |  |  |
| [ ] | P2 | #73831 | [Bug]: undici HTTP/2 hang on Windows extends from Telegram polling into the LLM model dispatcher (related to #66885) |  |  |
| [ ] | P2 | #73323 | [Bug]: Gateway runtime degradation: pricing fetch 60s timeouts, Telegram polling stalls, slow RPC — chronic across 4.23/4.25/4.26 on Windows 11 + Node 24 | `bug` |  |
| [ ] | P2 | #73059 | [Bug]: Windows linked source install can skip Control UI auto-build through junction-launched scripts/ui.js |  |  |
| [ ] | P2 | #72922 | [Bug]:  Sluggish response time and unstable Web GUI and CLI on Windows Server 2022 | `bug` |  |
| [ ] | P2 | #71717 | exec tool returns EPERM on Windows, all commands fail | `bug` |  |
| [ ] | P2 | #70451 | [Bug]: CLI hooks enable times out / SIGKILL on Windows |  |  |
| [ ] | P2 | #66746 | [Bug] Windows memory indexing falls back to FTS-only in 2026.4.14 even though direct node:sqlite + sqlite-vec works |  |  |
| [ ] | P2 | #66479 | Windows: skill not discovered due to UTF-8 BOM injected by PowerShell WriteAllText |  |  |
| [ ] | P2 | #65164 | All outbound HTTP fails inside gateway process on Windows 10 + Node 22 (WebSocket works) |  |  |
| [ ] | P2 | #64443 | OpenClaw chat interface causes very high WindowServer CPU on Intel Retina iMac |  |  |
| [ ] | P2 | #64253 | Gateway becomes unresponsive under subagent load on Windows - completion announcements timeout |  |  |
| [ ] | P2 | #64187 | [Bug]: Windows memory search hits EBUSY during sqlite atomic reindex swap |  |  |
| [ ] | P2 | #63491 | [Bug]: Windows Scheduled Task gateway restart/health becomes inconsistent after ready |  |  |
| [ ] | P2 | #60713 | Windows: resolvePreferredOpenClawTmpDir uses C:\tmp instead of proper temp directory |  |  |
| [ ] | P2 | #59709 | Cron scheduled task delivery fails (v2026.3.31) |  |  |
| [ ] | P2 | #59281 | [Bug]: Windows plugin TS source-loading via jiti is pathologically slow in real production call sites | `bug` `bug:behavior` |  |
| [ ] | P2 | #58433 | [Bug]: [Windows] Path character loss bug - "system" becomes "ystem" in file paths | `bug` `bug:behavior` |  |
| [ ] | P2 | #58139 | [Bug]: memory-lancedb plugin fails with Windows Docker bind mount | `bug` `bug:behavior` |  |
| [ ] | P2 | #56284 | Windows: gateway restart does not wait for active tasks and loses session state |  |  |
| [ ] | P2 | #56106 | Transcript JSONL encoding corrupted on Windows (GBK/UTF-8 mix) |  |  |
| [ ] | P2 | #48780 | [Bug]: [Windows] exec() and read() commands corrupted with </arg_value>> suffix | `bug` `stale` `bug:behavior` |  |
| [ ] | P2 | #44559 | [Bug]: Windows： Gateway 关闭 PowerShell 窗口后断连 | `bug` `bug:behavior` |  |
| [ ] | P2 | #44296 | Show the actual PowerShell profile path during onboarding shell-completion setup |  |  |
| [ ] | P2 | #44293 | Make `pnpm check:docs` work in native PowerShell |  |  |
| [ ] | P2 | #44291 | Add native PowerShell smoke coverage for contributor commands |  |  |
| [ ] | P2 | #40694 | Browser-opened temporary tabs/windows should close automatically after task completion |  |  |
| [ ] | P2 | #40540 | [Bug]: `openclaw update` command fails with EBUSY error on Windows | `bug` `bug:behavior` |  |

### Feature Requests

| Resolved? | Priority | # | Title | Labels | Assignee |
| --------- | -------- | - | ----- | ------ | -------- |
| [ ] | P2 | #72595 | [Feature]: Feishu channel needs per-channel proxy bypass for mixed Windows proxy setups | `enhancement` |  |
| [ ] | P2 | #57775 | Windows headless node host supports exec approvals via CLI, but nodes describe / Control UI do not advertise system.execApprovals.get/set |  |  |
| [ ] | P2 | #46590 | Feature Request: Add `cron` field to Agent configuration for Agent-owned scheduled tasks | `stale` |  |
| [ ] | P2 | #18985 | [Feature]: Supports Windows 11 MSYS environment and Fishshell. | `enhancement` |  |
| [ ] | P2 | #7057 | Flaky tests on Windows/WSL: timeouts and ENOENT in pi-tools workspace-paths & safe-bins | `enhancement` |  |
| [ ] | P2 | #75 | Linux/Windows Clawdbot Apps | `enhancement` `help wanted` |  |

---

## 4. Windows Platform — PRs

| Resolved? | Priority | # | Title | Size | Assignee |
| --------- | -------- | - | ----- | ---- | -------- |
| [ ] | P0 | #72782 | fix(security): replace console.warn with structured logger in windows… | XS |  |
| [ ] | P0 | #63074 | fix(security): classify dangerous Windows sandbox binds first | M |  |
| [ ] | P0 | #42174 | fix: false error of Windows path when binding the host path to the sandbox. | XS |  |
| [ ] | P0 | #38846 | security(windows): enhance command argument validation | S |  |
| [ ] | P1 | #53788 | docs(windows): companion app copy and GitHub auth notes | XS |  |
| [ ] | P1 | #46371 | fix: Windows npm path for Gemini OAuth + feat: WORKING.md bootstrap (#46368, #46367) | S |  |
| [ ] | P2 | #74173 | fix: enable native require fast path on Windows for bundled plugins | XS |  |
| [ ] | P2 | #73889 | fix(cli): stabilize Windows scheduled-task restart health after ready | S |  |
| [ ] | P2 | #73751 | fix(exec): decode Windows command output with codepage-aware streaming | M |  |
| [ ] | P2 | #73674 | fix(memory): resolve QMD Windows cmd shims | S |  |
| [ ] | P2 | #73533 | fix(infra): skip POSIX /tmp preferred path on Windows (#60713) | S |  |
| [ ] | P2 | #73474 | fix(gateway,proxy): bypass Windows proxy for localhost gateway connections | XS |  |
| [ ] | P2 | #71611 | fix(memory): retry rename on EBUSY and fall back to copyFile on Windows | XS |  |
| [ ] | P2 | #70762 | refactor(agents): share hook history windows | XL | @vincentkoc |
| [ ] | P2 | #70341 | fix(exec): resolve Windows PowerShell cmdlet allowlist miss | M |  |
| [ ] | P2 | #69701 | fix(gateway): skip IPv6 ::1 loopback binding on Windows to prevent HTTP hang | XS |  |
| [ ] | P2 | #69059 | fix: retry sqlite-vec load without .dll suffix on Windows | S |  |
| [ ] | P2 | #68853 | fix(gateway): SIGUSR1 restart fast path that doesn't break Windows schtasks | M |  |
| [ ] | P2 | #68819 | fix: resolve Windows .cmd shims to underlying .exe before spawn | M |  |
| [ ] | P2 | #68725 | feat(amazon-bedrock-mantle): add known context windows for open-weight Mantle models | S |  |
| [ ] | P2 | #68149 | feat(daemon): use PowerShell Register-ScheduledTask for Windows auto-start | M |  |
| [ ] | P2 | #67655 | fix(exec): fail closed on Windows shell wrappers in allowlist mode | XS |  |
| [ ] | P2 | #64110 | feat: Deleting scheduled tasks also clears tasks in the queue. | L |  |
| [ ] | P2 | #63651 | fix: remove duplicate restart message on Windows (schtasks) | S |  |
| [ ] | P2 | #62910 | fix(scripts): avoid DEP0190 when spawning .cmd files on Windows (Node.js v24) | XS |  |
| [ ] | P2 | #60678 | fix(acpx): add windowsHide to MCP proxy spawn on Windows | XS |  |
| [ ] | P2 | #59705 | [codex] improve parallels windows smoke logging | M |  |
| [ ] | P2 | #59013 | fix: tolerate EPERM in session write-lock on Windows | S |  |
| [ ] | P2 | #53965 | fix: atomic file writes on Windows-mounted Docker volumes | XS |  |
| [ ] | P2 | #53950 | docs: add hypervisorlaunchtype toggle recovery to WSL2+Windows remote CDP guide | XS |  |
| [ ] | P2 | #52989 | fix: use pathToFileURL for Windows path comparison in generate-base-config-schema | XS |  |
| [ ] | P2 | #52487 | fix(windows): prevent restart race from duplicate schtasks /Run | XS |  |
| [ ] | P2 | #52200 | fix(skills): normalize backslashes in compacted skill paths on Windows | XS |  |
| [ ] | P2 | #51486 | fix(daemon): query Windows task runtime directly | S |  |
| [ ] | P2 | #50136 | fix(windows): stabilize gateway restart and avoid false stale cleanup [AI-assisted] | M |  |
| [ ] | P2 | #50116 | fix: handle Windows-style session paths when running on POSIX | XS |  |
| [ ] | P2 | #48887 | Fix/docs format check windows clean | M |  |
| [ ] | P2 | #48320 | fix(windows): add windowsHide to all Windows spawn resolution paths | XS |  |
| [ ] | P2 | #48130 | fix: correct Windows Chrome executable path extraction regex | XS |  |
| [ ] | P2 | #46956 | feat(cli): add trust windows for time-bounded exec approval | XL |  |
| [ ] | P2 | #45870 | fix: align windows path tests with runtime behavior | S |  |
| [ ] | P2 | #45380 | Make env-prefixed npm scripts work on Windows | S |  |
| [ ] | P2 | #44614 | fix(windows): delegate npm global update to detached helper to avoid EBUSY | M |  |
| [ ] | P2 | #44228 | fix(reply): normalize Windows media paths for dedupe | XS |  |
| [ ] | P2 | #44215 | fix(path): add Windows PATH bootstrap dirs | S |  |
| [ ] | P2 | #44013 | feat: add Linux and Windows desktop apps using Tauri | L |  |
| [ ] | P2 | #43975 | fix(windows): bootstrap UTF-8 before running gateway task script | S |  |
| [ ] | P2 | #42131 | fix(doctor): case-insensitive safe-bin trusted dir matching on macOS/Windows | S |  |
| [ ] | P2 | #39644 | fix(windows): PowerShell completion install and time-format detection | S |  |
| [ ] | P2 | #39126 | feat(exec): add session-based trust windows for exec approvals | XL |  |
| [ ] | P2 | #38932 | docs(gateway): add Windows no-Docker hardening fallback guide | XS |  |

---

## 5. WSL (Windows Subsystem for Linux) — Issues

### Bugs / Crashes

| Resolved? | Priority | # | Title | Labels | Assignee |
| --------- | -------- | - | ----- | ------ | -------- |
| [ ] | P1 | #68966 | [Bug]: [WSL] openclaw browser command terminated by SIGKILL causing timeout | `bug` `bug:crash` |  |
| [ ] | P1 | #59209 | Misleading CDP "Empty reply from server" in WSL2 caused by portproxy self-loop (svchost/iphlpsvc), not Chrome | `bug` `regression` |  |
| [ ] | P1 | #44051 | [Bug]: [skills] Skipping skill path error triggered on officially installed skills via clawhub (WSL Environment) | `bug` `stale` `regression` |  |
| [ ] | P2 | #73602 | [Bug]: WhatsApp flaps and Telegram polling stalls on WSL2 in 2026.4.26 |  |  |
| [ ] | P2 | #73592 | [Bug]: WSL local gateway binds but WebSocket handshake times out on 2026.4.26 |  |  |
| [ ] | P2 | #73152 | Docs/doctor request: clarify gateway reachability for OrbStack/WSL/VM/Tailscale setups |  |  |
| [ ] | P2 | #72693 | [Bug] 2026.4.24 on WSL2: Ghost EADDRINUSE loop & systemd split-brain |  |  |
| [ ] | P2 | #61616 | [Bug]: [WSL2] Global 30-min gateway stall (:29/:59) affects Telegram + Control UI | `bug` |  |

### Feature Requests

| Resolved? | Priority | # | Title | Labels | Assignee |
| --------- | -------- | - | ----- | ------ | -------- |
| [ ] | P1 | #67060 | [Feature]: Provider requests ignore env proxy by default → causes silent timeout in WSL / proxy environments | `enhancement` |  |
| [ ] | P2 | #62697 | feat(whatsapp): Support WhatsApp Channel (Newsletter) messages |  |  |
| [ ] | P2 | #13417 | WhatsApp Newsletter/Channel support in message tool | `enhancement` |  |

---

## 6. WSL (Windows Subsystem for Linux) — PRs

| Resolved? | Priority | # | Title | Size | Assignee |
| --------- | -------- | - | ----- | ---- | -------- |
| [ ] | P1 | #46698 | fix(auth): fix GitHub device flow polling and add --wait flag for WSL… | S |  |
| [ ] | P2 | #73393 | feat(whatsapp): support newsletter targets in message tool | M |  |
| [ ] | P2 | #73227 | fix: dashboard command missing token hint in headless/WSL (#72081) | XS |  |
| [ ] | P2 | #68400 | daemon/systemd: distinguish WSL user D-Bus socket missing from missing systemctl | S |  |
| [ ] | P2 | #59219 | fix[Bug]: [skills] Skipping skill path error triggered on officially installed skills via clawhub (WSL Environment) | M |  |
| [ ] | P2 | #59126 | docs(contributing): add Development Environment section with WSL2 setup guide | XS |  |
| [ ] | P2 | #58853 | feat(doctor): add WSL environment diagnostics check [AI-assisted] | L |  |
| [ ] | P2 | #44129 | fix(skills): exempt managed skills from path escaping checks on WSL (#44051) | S |  |

---

## 7. Azure (Provider / Infrastructure) — Issues

### Bugs / Crashes

| Resolved? | Priority | # | Title | Labels | Assignee |
| --------- | -------- | - | ----- | ------ | -------- |
| [ ] | P2 | #64960 | Compaction fails permanently when Azure content filter blocks summarization — no model fallback |  |  |
| [ ] | P2 | #60546 | [Bug]: microsoft-foundry provider selects Claude deployments but routes them through OpenAI Foundry endpoints |  |  |
| [ ] | P2 | #48793 | feat: centralized PluginResourceManager interface for consistent async cleanup across all channel plugins | `stale` |  |
| [ ] | P2 | #48788 | feat: centralized filename encoding utility for multi-encoding Content-Disposition handling |  |  |

### Feature Requests

| Resolved? | Priority | # | Title | Labels | Assignee |
| --------- | -------- | - | ----- | ------ | -------- |
| [ ] | P1 | #51869 | [Bug]: onboard-custom hardcodes input: ["text"] for non-Azure custom providers, silently disabling image/vision support | `stale` |  |
| [ ] | P2 | #71058 | [Feature]: Support for multiple Azure/Teams bots on a single Openclaw Gateway | `enhancement` |  |

---

## 8. Azure (Provider / Infrastructure) — PRs

| Resolved? | Priority | # | Title | Size | Assignee |
| --------- | -------- | - | ----- | ---- | -------- |
| [ ] | P1 | #55395 | fix: centralize plugin command auth requirements | M |  |
| [ ] | P2 | #70922 | refactor(whatsapp): centralize account policy | L |  |
| [ ] | P2 | #68502 | docs: add Azure AI Foundry provider guide | XS |  |
| [ ] | P2 | #57468 | refactor(models): centralize model metadata and provider-aware resolution | XL |  |
| [ ] | P2 | #56705 | Config: centralize known plugin ID resolution for validation | M |  |
| [ ] | P2 | #55211 | fix: prevent re-entrant loop in internal hook trigger | S |  |
| [ ] | P2 | #52555 | docs: add Azure Container Apps install guide with managed identity an… | XS |  |
| [ ] | P2 | #47285 | feat(memory-lancedb): native Azure OpenAI support | XS |  |
| [ ] | P2 | #47181 | feat: add Azure Claude (AI Foundry) onboarding path | L |  |

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

| Category | Type | Priority | # | Title |
| -------- | ---- | -------- | - | ----- |
| MS Teams (channel plugin) | pr | P0 | #73590 | feat: add tool-scoped hooks and fork guard |
| MS Teams (channel plugin) | pr | P0 | #68077 | fix: MS Teams OAuth on Windows and browser.cdpUrl security redaction |
| MS Teams (channel plugin) | pr | P0 | #63827 | fix(security): preserve dmPolicy settings during wizard runs |
| Windows platform | pr | P0 | #72782 | fix(security): replace console.warn with structured logger in windows… |
| Windows platform | pr | P0 | #63074 | fix(security): classify dangerous Windows sandbox binds first |
| Windows platform | pr | P0 | #42174 | fix: false error of Windows path when binding the host path to the sandbox. |
| Windows platform | pr | P0 | #38846 | security(windows): enhance command argument validation |

## Appendix: High-Priority Bugs / Regressions

| Category | Type | Priority | # | Title |
| -------- | ---- | -------- | - | ----- |
| MS Teams (channel plugin) | issue | P1 | #73754 | msteams: v2026.4.26 ships broken JWT validator (jwt.verify is not a function); fix b3bc60ae missed the cut |
| MS Teams (channel plugin) | issue | P1 | #67659 | [Bug]: MS Teams delegated OAuth launcher uses xdg-open on win32 instead of explorer.exe |
| MS Teams (channel plugin) | issue | P1 | #67177 | [msteams] Inbound file attachments silently fail in DMs — file.download.info downloadUrl not rewritten to Graph shares endpoint |
| MS Teams (channel plugin) | issue | P1 | #65329 | bug(msteams): DM inline images and file attachments silently dropped |
| MS Teams (channel plugin) | issue | P1 | #62765 | msteams dmPolicy=pairing silently drops unpaired senders with HTTP 200, no log line, no auto-reply |
| MS Teams (channel plugin) | pr | P1 | #67660 | fix(msteams): use explorer.exe for delegated OAuth on win32 |
| MS Teams (channel plugin) | pr | P1 | #54803 | /status: show usage fetch errors instead of silently hiding |
| MS Teams (channel plugin) | pr | P1 | #48014 | feat(msteams): add DefaultAzureCredential auth type for passwordless Teams auth |
| Windows platform | issue | P1 | #74086 | [Bug]: Regression: Telegram provider fails on Windows after 2026.4.23 (deleteWebhook / setMyCommands errors) |
| Windows platform | issue | P1 | #73874 | Gateway HTTP/WS dispatch deadlock on Windows + Docker Desktop bind-mount setups (regression in 2026.4.24, persists in .25 and .26) |
| Windows platform | issue | P1 | #71865 | Auth login blocked by size-drop guard when openclaw.json was created by PowerShell (verbose/BOM format) |
| Windows platform | issue | P1 | #71699 | [Bug]: Gateway hard-crashes with 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) on Windows during Mattermost streaming reply; auto-respawn frequently wedges |
| Windows platform | issue | P1 | #70857 | [Bug]: Windows startup and reply latency, session lock held for 191s on sessions.json.lock |
| Windows platform | issue | P1 | #70856 | [Bug]: WhatsApp listener repeatedly disconnects/stalls on Windows, causing "No active WhatsApp Web listener" and missed messages |
| Windows platform | issue | P1 | #70788 | fix(windows): suppress startup-folder cmd window flash via wscript silent launcher |
| Windows platform | issue | P1 | #68656 | Slow startup on Windows (~39s before ready) with long silent gap before plugin registration |
| Windows platform | issue | P1 | #68493 | [Bug]: Editing openclaw.json while gateway is running triggers hot-reload crash loop on Windows (stale lock file + EADDRINUSE) |
| Windows platform | issue | P1 | #67035 | [Bug]: 2026.4.14 Windows chat UI regression: input text swallowed, streamed replies often invisible until refresh, typing indicator flashes then blanks |
| Windows platform | issue | P1 | #63257 | Windows Gateway Feishu API timeout 30s at startup |
| Windows platform | issue | P1 | #62099 | EPERM on auth-profiles.json causes full gateway failure cascade (Windows) |
| Windows platform | issue | P1 | #62055 | Windows: CLI crashes with stack overflow / heap OOM on v2026.4.5 (large ESM module graph exceeds V8 default stack) |
| Windows platform | issue | P1 | #59362 | [Bug]: Windows: exec tool causes console window flash when spawning commands |
| Windows platform | issue | P1 | #54669 | [Field Report] Chrome 136+ binds CDP to [::1] (IPv6) on Windows — portproxy v4tov4 breaks silently |
| Windows platform | issue | P1 | #54470 | [Bug]:  openclaw webhooks gmail setup fails on native Windows with `Error: spawn gcloud ENOENT` |
| Windows platform | issue | P1 | #47643 | [Bug]: Persistent Telegram Channel Issues: Sync Failures, Loops, and Config Changes Not Applying on Windows |
| Windows platform | issue | P1 | #46378 | [Bug]: 安装配置界面windows会卡死 |
| Windows platform | issue | P1 | #42011 | [Bug]: Control UI chat can stay stuck on "Stop" after embedded run timeout on Windows |
| Windows platform | issue | P1 | #39038 | [Bug]: OpenClaw节点程序在Windows 11 24H2上启动后卡在PATH信息，无法连接Gateway |
| Windows platform | pr | P1 | #53788 | docs(windows): companion app copy and GitHub auth notes |
| Windows platform | pr | P1 | #46371 | fix: Windows npm path for Gemini OAuth + feat: WORKING.md bootstrap (#46368, #46367) |
| WSL | issue | P1 | #68966 | [Bug]: [WSL] openclaw browser command terminated by SIGKILL causing timeout |
| WSL | issue | P1 | #67060 | [Feature]: Provider requests ignore env proxy by default → causes silent timeout in WSL / proxy environments |
| WSL | issue | P1 | #59209 | Misleading CDP "Empty reply from server" in WSL2 caused by portproxy self-loop (svchost/iphlpsvc), not Chrome |
| WSL | issue | P1 | #44051 | [Bug]: [skills] Skipping skill path error triggered on officially installed skills via clawhub (WSL Environment) |
| WSL | pr | P1 | #46698 | fix(auth): fix GitHub device flow polling and add --wait flag for WSL… |
| Azure | issue | P1 | #51869 | [Bug]: onboard-custom hardcodes input: ["text"] for non-Azure custom providers, silently disabling image/vision support |
| Azure | pr | P1 | #55395 | fix: centralize plugin command auth requirements |

## Appendix: Stale Items (Consider Closing)

| Category | Type | Priority | # | Title |
| -------- | ---- | -------- | - | ----- |
| MS Teams (channel plugin) | pr | P2 | #40463 | fix(msteams): fix image attachment download for channel and DM messages |
| MS Teams (channel plugin) | pr | P2 | #34581 | fix(msteams): handle invalid JSON escape sequences in Bot Framework activities |
| MS Teams (channel plugin) | pr | P2 | #32558 | MSTeams: add upload session fallback for large files |
| MS Teams (channel plugin) | pr | P2 | #30142 | feat(adapters): add sendPayload to batch-b (Discord, Google Chat, Mattermost, MS Teams, Slack, Synology) |
| Windows platform | issue | P1 | #47643 | [Bug]: Persistent Telegram Channel Issues: Sync Failures, Loops, and Config Changes Not Applying on Windows |
| Windows platform | issue | P1 | #46378 | [Bug]: 安装配置界面windows会卡死 |
| Windows platform | issue | P2 | #48780 | [Bug]: [Windows] exec() and read() commands corrupted with </arg_value>> suffix |
| Windows platform | issue | P2 | #46590 | Feature Request: Add `cron` field to Agent configuration for Agent-owned scheduled tasks |
| Windows platform | pr | P2 | #53965 | fix: atomic file writes on Windows-mounted Docker volumes |
| WSL | issue | P1 | #44051 | [Bug]: [skills] Skipping skill path error triggered on officially installed skills via clawhub (WSL Environment) |
| WSL | pr | P2 | #44129 | fix(skills): exempt managed skills from path escaping checks on WSL (#44051) |
| Azure | issue | P1 | #51869 | [Bug]: onboard-custom hardcodes input: ["text"] for non-Azure custom providers, silently disabling image/vision support |
| Azure | issue | P2 | #48793 | feat: centralized PluginResourceManager interface for consistent async cleanup across all channel plugins |

## Audit Notes

- Rebuilt from the format of PR #49126 after the issue/PR purge.
- Source set is currently open GitHub issues and PRs from `openclaw/openclaw`; closed counts are intentionally reset to `0` for this refreshed tracker.
- Included title/label matches for `msteams`, Microsoft Teams, Windows, WSL, Azure, Entra/AAD, MSAL, managed identity, DefaultAzureCredential, Microsoft Graph, SharePoint, OneDrive, and Microsoft 365.
- Kept broad multi-channel PRs when they carry `channel: msteams`, because those can still affect the Microsoft surface area.
- Generated with `node scripts/generate-microsoft-tracker.mjs` so the tracker and PR body can be refreshed after future triage passes.
