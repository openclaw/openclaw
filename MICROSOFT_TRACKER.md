# Microsoft Ecosystem Issues & PRs Tracker

> **Purpose:** Living checklist for maintainers to track all open Microsoft-related issues and PRs (Teams, Windows, WSL, Azure, M365/SharePoint). Edit this file directly to update status.
>
> **How to use:**
> - Check the `Resolved?` box when an issue/PR is closed, merged, or no longer relevant
> - Claim items by adding your GitHub handle to the `Assignee` column
> - Priority guide: **P0** = crash/blocker, **P1** = significant bug/regression, **P2** = minor bug/enhancement, **P3** = nice-to-have/stale
> - Items marked *(stale)* have been flagged by the stale bot due to inactivity
>
> **Last updated:** 2026-03-17

---

## Summary

| Category | Issues | PRs | Total |
|---|---|---|---|
| MS Teams (channel plugin) | 28 | 30+ | ~58 |
| Windows (platform) | 55+ | 22+ | ~77 |
| WSL | 10 | 7 | ~17 |
| Azure (provider/infra) | 14 | 11 | ~25 |
| Microsoft 365 / SharePoint | 3 | 0 | 3 |
| **Total (deduplicated)** | **~90** | **~55** | **~145** |

---

## 1. MS Teams Channel Plugin - Issues

### Bugs / Crashes

| Resolved? | Priority | # | Title | Labels | Assignee |
|---|---|---|---|---|---|
| [ ] | P0 | [#44857](https://github.com/openclaw/openclaw/issues/44857) | Broken bundled msteams extension | `bug` `bug:crash` | |
| [ ] | P0 | [#43648](https://github.com/openclaw/openclaw/issues/43648) | MS Teams: inline pasted images fail to download (hostedContents contentBytes always null) | `bug` `bug:crash` | |
| [ ] | P1 | [#43323](https://github.com/openclaw/openclaw/issues/43323) | MS Teams pairing drops first DM before saving conversation reference, so --notify always fails | `bug` `bug:behavior` | |
| [ ] | P1 | [#47268](https://github.com/openclaw/openclaw/issues/47268) | [msteams] FileConsentCard not updated after user accepts - consent card remains frozen | | |
| [ ] | P1 | [#38629](https://github.com/openclaw/openclaw/issues/38629) | msteams implicit mention fails - replyToId unreliable, threadRootId not used as fallback | | |
| [ ] | P1 | [#35822](https://github.com/openclaw/openclaw/issues/35822) | MS Teams DM file attachments fail: Graph API chatId format mismatch and messageId encoding error | | |
| [ ] | P1 | [#29379](https://github.com/openclaw/openclaw/issues/29379) | MS Teams plugin drops all text blocks after the first in multi-block replies | | |
| [ ] | P1 | [#29847](https://github.com/openclaw/openclaw/issues/29847) | fix(msteams): FileConsent upload succeeds but FileInfoCard fails - TurnContext proxy revoked | | |
| [ ] | P1 | [#27885](https://github.com/openclaw/openclaw/issues/27885) | msteams provider exits immediately, causing infinite auto-restart loop | | |
| [ ] | P1 | [#25790](https://github.com/openclaw/openclaw/issues/25790) | msteams plugin: duplicate provider start causes EADDRINUSE crash loop (bundled + standalone conflict) | | |
| [ ] | P1 | [#24148](https://github.com/openclaw/openclaw/issues/24148) | Cross-channel reply context leak - Teams DM overwrites session reply target | `bug` | |
| [ ] | P1 | [#24088](https://github.com/openclaw/openclaw/issues/24088) | Plugin MSTeams en OpenClaw | `bug` | |
| [ ] | P1 | [#23453](https://github.com/openclaw/openclaw/issues/23453) | MS Teams: Inline images (Ctrl+V) in DMs not downloaded - Graph fallback fails | | |
| [ ] | P1 | [#22975](https://github.com/openclaw/openclaw/issues/22975) | Teams 2-step response fails - only first message (reply to user) works | `bug` | |
| [ ] | P1 | [#22169](https://github.com/openclaw/openclaw/issues/22169) | msteams provider starts twice on gateway boot, causing EADDRINUSE restart loop | `bug` | |
| [ ] | P1 | [#42099](https://github.com/openclaw/openclaw/issues/42099) | fix(plugins): false-positive duplicate plugin ID warning on gateway start (msteams) | | |
| [ ] | P2 | [#28014](https://github.com/openclaw/openclaw/issues/28014) | [msteams] Inline image downloads fail in 1:1 chats - bot adapter token instead of MSAL Graph token *(stale)* | `stale` | |
| [ ] | P2 | [#26599](https://github.com/openclaw/openclaw/issues/26599) | [MSTeams] Regular messages falsely detected as `<media:document>` *(stale)* | `stale` | |
| [ ] | P2 | [#24797](https://github.com/openclaw/openclaw/issues/24797) | MSTeams: Image attachments not downloaded in bot DM chats (3 bugs) *(stale)* | `stale` | |
| [ ] | P2 | [#17783](https://github.com/openclaw/openclaw/issues/17783) | Microsoft Teams channel setup fails on OpenClaw (Raspberry Pi) *(stale)* | `bug` `stale` | |
| [ ] | P2 | [#15622](https://github.com/openclaw/openclaw/issues/15622) | Teams extension deps wiped on every global npm update *(stale)* | `stale` | |
| [ ] | P2 | [#14436](https://github.com/openclaw/openclaw/issues/14436) | Gateway JWT middleware blocks Bot Framework webhooks in msteams plugin *(stale)* | `bug` `stale` | |

### Feature Requests

| Resolved? | Priority | # | Title | Labels | Assignee |
|---|---|---|---|---|---|
| [ ] | P2 | [#40865](https://github.com/openclaw/openclaw/issues/40865) | feat(msteams): Implement read and search message actions for Teams channel | | |
| [ ] | P2 | [#40855](https://github.com/openclaw/openclaw/issues/40855) | Support federated credentials / managed identity for MS Teams Bot Framework auth | | |
| [ ] | P2 | [#13243](https://github.com/openclaw/openclaw/issues/13243) | msteams support resumable Graph upload session for files >4MB | `enhancement` | |
| [ ] | P2 | [#11346](https://github.com/openclaw/openclaw/issues/11346) | feat(msteams): Add Graph API-based message history query (readMessages action) | `enhancement` | |
| [ ] | P2 | [#7031](https://github.com/openclaw/openclaw/issues/7031) | Simplify Teams integration for M365-only organizations (no Azure subscription) | `enhancement` | |
| [ ] | P3 | [#19908](https://github.com/openclaw/openclaw/issues/19908) | WhatsApp Channel Reliability Issues - Migration to Teams Graph *(stale)* | `stale` | |

---

## 2. MS Teams Channel Plugin - PRs

| Resolved? | Priority | # | Title | Size | Assignee |
|---|---|---|---|---|---|
| [ ] | P0 | [#48659](https://github.com/openclaw/openclaw/pull/48659) | MSTeams: harden channel integration and readable focus labels | XL | |
| [ ] | P1 | [#48014](https://github.com/openclaw/openclaw/pull/48014) | feat(msteams): add DefaultAzureCredential auth type for passwordless Teams auth | L | |
| [ ] | P1 | [#47934](https://github.com/openclaw/openclaw/pull/47934) | fix(msteams): address review feedback on #40884 - schema, types, env validation | M | |
| [ ] | P1 | [#47860](https://github.com/openclaw/openclaw/pull/47860) | fix(msteams): add fetch timeout to Microsoft Graph API calls | XS | |
| [ ] | P1 | [#47270](https://github.com/openclaw/openclaw/pull/47270) | fix(msteams): update FileConsentCard in-place after upload via updateActivity | S | |
| [ ] | P1 | [#44899](https://github.com/openclaw/openclaw/pull/44899) | fix: add missing @microsoft/agents-hosting dependency for msteams extension | S | |
| [ ] | P1 | [#44739](https://github.com/openclaw/openclaw/pull/44739) | feat(msteams): extract structured quote/reply context from HTML attachments | M | |
| [ ] | P1 | [#43934](https://github.com/openclaw/openclaw/pull/43934) | fix(msteams): persist conversation reference during DM pairing | S | |
| [ ] | P1 | [#43761](https://github.com/openclaw/openclaw/pull/43761) | fix(msteams): add @microsoft/agents-hosting to root dependencies | XS | |
| [ ] | P1 | [#43414](https://github.com/openclaw/openclaw/pull/43414) | fix(msteams): persist first-DM conversation reference in pairing path | S | |
| [ ] | P1 | [#43326](https://github.com/openclaw/openclaw/pull/43326) | feat(msteams): fetch thread history via Graph API for channel replies | M | |
| [ ] | P1 | [#43190](https://github.com/openclaw/openclaw/pull/43190) | MS Teams: add channel archive persistence and deleted-channel cleanup | XL | |
| [ ] | P1 | [#41565](https://github.com/openclaw/openclaw/pull/41565) | feat(cards): add shared adaptive card rendering for all channels | XL | |
| [ ] | P1 | [#41108](https://github.com/openclaw/openclaw/pull/41108) | fix(msteams): detect implicit mentions in thread replies via conversation.id | S | |
| [ ] | P1 | [#40884](https://github.com/openclaw/openclaw/pull/40884) | feat(msteams): support federated credentials and certificate auth | S | |
| [ ] | P1 | [#40463](https://github.com/openclaw/openclaw/pull/40463) | fix(msteams): fix image attachment download for channel and DM messages | M | |
| [ ] | P1 | [#39352](https://github.com/openclaw/openclaw/pull/39352) | fix(msteams): pass teamId into inbound route resolution | S | |
| [ ] | P2 | [#37853](https://github.com/openclaw/openclaw/pull/37853) | feat(msteams): add Teams reaction support | M | |
| [ ] | P2 | [#34581](https://github.com/openclaw/openclaw/pull/34581) | fix(msteams): handle invalid JSON escape sequences in Bot Framework activities | M | |
| [ ] | P2 | [#34532](https://github.com/openclaw/openclaw/pull/34532) | docs: add Teams academic chat Canvas MVP host-side guide | XS | |
| [ ] | P2 | [#33343](https://github.com/openclaw/openclaw/pull/33343) | fix(msteams): sanitize error messages sent to users (CWE-209) | XS | |
| [ ] | P2 | [#32558](https://github.com/openclaw/openclaw/pull/32558) | MSTeams: add upload session fallback for large files | M | |
| [ ] | P2 | [#32555](https://github.com/openclaw/openclaw/pull/32555) | fix(msteams): clear pending upload timeout on removal | XS | |
| [ ] | P2 | [#30142](https://github.com/openclaw/openclaw/pull/30142) | feat(adapters): add sendPayload to batch-b (includes MS Teams) | L | |
| [ ] | P2 | [#23596](https://github.com/openclaw/openclaw/pull/23596) | fix(msteams): add SSRF validation to file consent upload URL | M | |
| [ ] | P2 | [#22325](https://github.com/openclaw/openclaw/pull/22325) | fix(security): prevent memory exhaustion in inline image decoding | S | |
| [ ] | P2 | [#21739](https://github.com/openclaw/openclaw/pull/21739) | feat(msteams): support resumable upload sessions for files > 4MB | S | |
| [ ] | P2 | [#18716](https://github.com/openclaw/openclaw/pull/18716) | msteams: fix DM image delivery + user target routing | S | |
| [ ] | P3 | [#27765](https://github.com/openclaw/openclaw/pull/27765) | msteams: allow replyStyle config override for DMs *(stale)* | XS | |
| [ ] | P3 | [#26668](https://github.com/openclaw/openclaw/pull/26668) | MSTeams: add upload session fallback for large files | L | |
| [ ] | P3 | [#26274](https://github.com/openclaw/openclaw/pull/26274) | msteams: fix image download auth, double-counting, and typing indicator *(stale)* | M | |
| [ ] | P3 | [#25511](https://github.com/openclaw/openclaw/pull/25511) | fix(msteams): suppress reasoning-only text in outbound rendering *(stale)* | XS | |
| [ ] | P3 | [#8964](https://github.com/openclaw/openclaw/pull/8964) | test(msteams): add comprehensive tests for graph-upload module *(stale)* | | |

---

## 3. Windows Platform - Issues

### Installation / Setup

| Resolved? | Priority | # | Title | Assignee |
|---|---|---|---|---|
| [ ] | P0 | [#48832](https://github.com/openclaw/openclaw/issues/48832) | [Windows] Module initialization error: CHANNEL_IDS not iterable on startup | |
| [ ] | P0 | [#48756](https://github.com/openclaw/openclaw/issues/48756) | Gateway restart/stop commands fail on Windows, causing connection loss | |
| [ ] | P0 | [#48736](https://github.com/openclaw/openclaw/issues/48736) | CLI WebSocket handshake timeout on Windows (~80% failure rate) | |
| [ ] | P1 | [#48780](https://github.com/openclaw/openclaw/issues/48780) | [Windows] exec() and read() commands corrupted with `</arg_value>>` suffix | |
| [ ] | P1 | [#48461](https://github.com/openclaw/openclaw/issues/48461) | Intermittent browser command failures on Windows (gateway closed, handshake timeout) | |
| [ ] | P1 | [#48079](https://github.com/openclaw/openclaw/issues/48079) | LINE plugin /line/webhook returns 404 on Windows | |
| [ ] | P1 | [#48043](https://github.com/openclaw/openclaw/issues/48043) | Chrome User Profile Attach Broken on Windows | |
| [ ] | P1 | [#47957](https://github.com/openclaw/openclaw/issues/47957) | CI check/startup-memory/windows-tests globally broken | |
| [ ] | P1 | [#47748](https://github.com/openclaw/openclaw/issues/47748) | Windows: `openclaw update` fails with `spawn EINVAL` | |
| [ ] | P1 | [#47643](https://github.com/openclaw/openclaw/issues/47643) | Persistent Telegram Channel Issues on Windows | |
| [ ] | P1 | [#47484](https://github.com/openclaw/openclaw/issues/47484) | openclaw_supervisor.ps1: unquoted paths break on Windows usernames with spaces | |
| [ ] | P1 | [#47445](https://github.com/openclaw/openclaw/issues/47445) | gateway restart command fails when executed via exec tool on Windows | |
| [ ] | P1 | [#46378](https://github.com/openclaw/openclaw/issues/46378) | Installation config UI freezes on Windows | |
| [ ] | P1 | [#45940](https://github.com/openclaw/openclaw/issues/45940) | False negative from `openclaw gateway probe` on Windows | |
| [ ] | P1 | [#45275](https://github.com/openclaw/openclaw/issues/45275) | `pnpm ui:build` fails: can't find `C:\Program` on Windows | |
| [ ] | P1 | [#44559](https://github.com/openclaw/openclaw/issues/44559) | Windows: Gateway disconnects when PowerShell window closes | |
| [ ] | P1 | [#44199](https://github.com/openclaw/openclaw/issues/44199) | Windows: ENOENT mkdir error in Telegram handler | |
| [ ] | P1 | [#43943](https://github.com/openclaw/openclaw/issues/43943) | [Windows] Gateway fails to start with Chinese username path | |
| [ ] | P1 | [#43180](https://github.com/openclaw/openclaw/issues/43180) | No hooks found - Windows pnpm install | |
| [ ] | P1 | [#42839](https://github.com/openclaw/openclaw/issues/42839) | Windows: openclaw agent --local returns 401 after clean reset | |
| [ ] | P1 | [#42556](https://github.com/openclaw/openclaw/issues/42556) | Plugin install fails on Windows with spawn EINVAL | |
| [ ] | P1 | [#41797](https://github.com/openclaw/openclaw/issues/41797) | install.ps1 forcefully exits PowerShell on systems without winget | |
| [ ] | P1 | [#40684](https://github.com/openclaw/openclaw/issues/40684) | npm install fails on Windows: git permission denied for libsignal-node | |
| [ ] | P1 | [#40613](https://github.com/openclaw/openclaw/issues/40613) | Windows 11 exec Chinese output becomes mojibake | |
| [ ] | P1 | [#40551](https://github.com/openclaw/openclaw/issues/40551) | [Windows + pnpm] Gateway dashboard returns 404 after upgrading | |
| [ ] | P1 | [#40540](https://github.com/openclaw/openclaw/issues/40540) | `openclaw update` fails with EBUSY error on Windows | |
| [ ] | P1 | [#40340](https://github.com/openclaw/openclaw/issues/40340) | bug(acpx): Windows console windows flash on every ACP spawn | |
| [ ] | P1 | [#40108](https://github.com/openclaw/openclaw/issues/40108) | Dashboard returns 404 on Windows with pnpm global install | |
| [ ] | P1 | [#39758](https://github.com/openclaw/openclaw/issues/39758) | OpenClaw 2026.3.7 Windows Setup Failure | |
| [ ] | P1 | [#39057](https://github.com/openclaw/openclaw/issues/39057) | `openclaw node status` reports "stopped" on German Windows | |
| [ ] | P1 | [#38054](https://github.com/openclaw/openclaw/issues/38054) | Windows install fails and immediately closes Powershell | |
| [ ] | P1 | [#37563](https://github.com/openclaw/openclaw/issues/37563) | `openclaw plugins install` fails on Windows when Node.js path contains spaces | |
| [ ] | P1 | [#37036](https://github.com/openclaw/openclaw/issues/37036) | In Windows, opening dashboard shows "Not Found" | |
| [ ] | P1 | [#35807](https://github.com/openclaw/openclaw/issues/35807) | Exec tool corrupts PowerShell pipeline variables on Windows | |
| [ ] | P1 | [#35796](https://github.com/openclaw/openclaw/issues/35796) | Windows node onboarding: no --token flag, config overwritten on restart | |
| [ ] | P1 | [#35297](https://github.com/openclaw/openclaw/issues/35297) | Control UI: Tools toggles don't persist / Save disabled on Windows | |
| [ ] | P1 | [#34189](https://github.com/openclaw/openclaw/issues/34189) | Control UI / Dashboard returns "Not Found" on Windows | |
| [ ] | P1 | [#34092](https://github.com/openclaw/openclaw/issues/34092) | Chat "copy button" not working on Windows | |
| [ ] | P1 | [#33862](https://github.com/openclaw/openclaw/issues/33862) | Feishu groupPolicy allowlist not working on Windows | |
| [ ] | P1 | [#33514](https://github.com/openclaw/openclaw/issues/33514) | bug(acpx): resolveWindowsSpawnProgramCandidate is not a function | |
| [ ] | P1 | [#31175](https://github.com/openclaw/openclaw/issues/31175) | Windows Node: exec-approvals socket not created automatically | |
| [ ] | P1 | [#30973](https://github.com/openclaw/openclaw/issues/30973) | MEDIA: token parser rejects Windows drive-letter paths | |
| [ ] | P1 | [#30072](https://github.com/openclaw/openclaw/issues/30072) | Windows: CLI startup regression ~14s vs ~3s | |
| [ ] | P1 | [#29949](https://github.com/openclaw/openclaw/issues/29949) | /restart command fails on Windows: missing schtasks support | |
| [ ] | P1 | [#29305](https://github.com/openclaw/openclaw/issues/29305) | Windows: acpx plugin binary verification fails under Scheduled Task | |
| [ ] | P1 | [#29134](https://github.com/openclaw/openclaw/issues/29134) | ACP runtime backend reports unavailable on Windows | |
| [ ] | P1 | [#28625](https://github.com/openclaw/openclaw/issues/28625) | Gemini CLI detection fails on Windows (npm global path mismatch) | |
| [ ] | P1 | [#28551](https://github.com/openclaw/openclaw/issues/28551) | Dashboard shows incorrect status on Windows: Version n/a, Health Offline | |
| [ ] | P1 | [#28283](https://github.com/openclaw/openclaw/issues/28283) | Exec approval gating intermittent on Windows | |
| [ ] | P1 | [#28270](https://github.com/openclaw/openclaw/issues/28270) | Fix version mismatch & zombie process on Windows | |
| [ ] | P2 | [#48689](https://github.com/openclaw/openclaw/issues/48689) | google-vertex auth broken on Windows in 2026.3.13 | |
| [ ] | P2 | [#47053](https://github.com/openclaw/openclaw/issues/47053) | tts.test.ts mock missing - Windows CI fails | |
| [ ] | P2 | [#45529](https://github.com/openclaw/openclaw/issues/45529) | Support stdin/file input for config set (PowerShell quote issues) | |
| [ ] | P2 | [#44487](https://github.com/openclaw/openclaw/issues/44487) | exec host=node broken from Mac gateway after 2026.3.11 | |
| [ ] | P2 | [#44362](https://github.com/openclaw/openclaw/issues/44362) | fix(backup): .backupignore permission check false-positives on Windows | |
| [ ] | P2 | [#44361](https://github.com/openclaw/openclaw/issues/44361) | fix(backup): archive integrity cross-check fails on Windows | |
| [ ] | P2 | [#44293](https://github.com/openclaw/openclaw/issues/44293) | Make `pnpm check:docs` work in native PowerShell | |
| [ ] | P2 | [#43931](https://github.com/openclaw/openclaw/issues/43931) | MEMORY.md injected twice on Windows NTFS (case-insensitive) | |
| [ ] | P2 | [#41800](https://github.com/openclaw/openclaw/issues/41800) | Gemini CLI OAuth broken on Windows (nvm) | |
| [ ] | P2 | [#38809](https://github.com/openclaw/openclaw/issues/38809) | [Windows] Image payload missing for google-generative-ai | |
| [ ] | P2 | [#37426](https://github.com/openclaw/openclaw/issues/37426) | Reply media dedupe should normalize Windows local paths | |
| [ ] | P2 | [#30878](https://github.com/openclaw/openclaw/issues/30878) | Flaky Windows CI test in path-safety | |
| [ ] | P2 | [#30403](https://github.com/openclaw/openclaw/issues/30403) | google-gemini-cli-auth OAuth fails on Windows | |
| [ ] | P2 | [#25399](https://github.com/openclaw/openclaw/issues/25399) | tools.exec.pathPrepend replaces PATH entirely on Windows | |
| [ ] | P2 | [#25282](https://github.com/openclaw/openclaw/issues/25282) | install on windows | |
| [ ] | P2 | [#22851](https://github.com/openclaw/openclaw/issues/22851) | Windows: exec tool creates visible console windows (conhost flash) | |
| [ ] | P2 | [#22554](https://github.com/openclaw/openclaw/issues/22554) | Telegram voice not auto-transcribed on Windows | |
| [ ] | P2 | [#19819](https://github.com/openclaw/openclaw/issues/19819) | SIGUSR1 restart crashes on Windows: EBADF bad file descriptor | |
| [ ] | P2 | [#16821](https://github.com/openclaw/openclaw/issues/16821) | exec tool mangles PowerShell $ syntax on Windows | |
| [ ] | P2 | [#5440](https://github.com/openclaw/openclaw/issues/5440) | Error when installing via CMD on Windows 11 | |
| [ ] | P3 | [#25856](https://github.com/openclaw/openclaw/issues/25856) | Windows: cmd.exe window flashes every ~30s from ARP scanning *(stale)* | |
| [ ] | P3 | [#25376](https://github.com/openclaw/openclaw/issues/25376) | Exec allowlist returns 'unsupported platform' on Windows *(stale)* | |
| [ ] | P3 | [#24441](https://github.com/openclaw/openclaw/issues/24441) | P0 Windows reliability: stale lock, cron EPERM, single-instance guard *(stale)* | |
| [ ] | P3 | [#23612](https://github.com/openclaw/openclaw/issues/23612) | OpenClaw installation fails on Windows *(stale)* | |
| [ ] | P3 | [#23509](https://github.com/openclaw/openclaw/issues/23509) | SIGUSR1 restart creates orphaned process as Scheduled Task *(stale)* | |
| [ ] | P3 | [#23109](https://github.com/openclaw/openclaw/issues/23109) | Silent failure sending local media on Windows via Telegram *(stale)* | |
| [ ] | P3 | [#21990](https://github.com/openclaw/openclaw/issues/21990) | Exec Tool on Windows does not capture stdout/stderr *(stale)* | |
| [ ] | P3 | [#21678](https://github.com/openclaw/openclaw/issues/21678) | Windows: missing windowsHide:true on child_process.spawn *(stale)* | |
| [ ] | P3 | [#16323](https://github.com/openclaw/openclaw/issues/16323) | Security: Insecure Default Tool Policies + Windows Command Injection *(stale)* | |

### Feature Requests

| Resolved? | Priority | # | Title | Assignee |
|---|---|---|---|---|
| [ ] | P2 | [#44038](https://github.com/openclaw/openclaw/issues/44038) | [Proposal] Windows Quick Installer GUI | |
| [ ] | P2 | [#38799](https://github.com/openclaw/openclaw/issues/38799) | Windows automation skills - bridging the platform gap | |
| [ ] | P2 | [#39821](https://github.com/openclaw/openclaw/issues/39821) | Add Ctrl+Enter (Windows) shortcut to send messages in Control UI | |
| [ ] | P2 | [#18985](https://github.com/openclaw/openclaw/issues/18985) | Supports Windows 11 MSYS environment and Fishshell | |
| [ ] | P2 | [#15027](https://github.com/openclaw/openclaw/issues/15027) | Conflicting installation guidance for Windows | |
| [ ] | P2 | [#10070](https://github.com/openclaw/openclaw/issues/10070) | canvas:a2ui:bundle script not Windows compatible | |
| [ ] | P3 | [#26160](https://github.com/openclaw/openclaw/issues/26160) | Windows support for obsidian skill *(stale)* | |
| [ ] | P3 | [#26110](https://github.com/openclaw/openclaw/issues/26110) | macOS-in-Docker for full experience on Linux/Windows x86 | |
| [ ] | P3 | [#75](https://github.com/openclaw/openclaw/issues/75) | Linux/Windows Clawdbot Apps | |

---

## 4. Windows Platform - PRs

| Resolved? | Priority | # | Title | Assignee |
|---|---|---|---|---|
| [ ] | P1 | [#48887](https://github.com/openclaw/openclaw/pull/48887) | Fix/docs format check windows clean | |
| [ ] | P1 | [#48613](https://github.com/openclaw/openclaw/pull/48613) | Fix/compatible with native windows | |
| [ ] | P1 | [#48557](https://github.com/openclaw/openclaw/pull/48557) | test: normalize Windows plugin path assertions | |
| [ ] | P1 | [#48544](https://github.com/openclaw/openclaw/pull/48544) | fix(tests): stabilize Windows CI cases | |
| [ ] | P1 | [#48320](https://github.com/openclaw/openclaw/pull/48320) | fix(windows): add windowsHide to all Windows spawn resolution paths | |
| [ ] | P1 | [#48130](https://github.com/openclaw/openclaw/pull/48130) | fix: correct Windows Chrome executable path extraction regex | |
| [ ] | P1 | [#47751](https://github.com/openclaw/openclaw/pull/47751) | fix: wrap bunx with cmd shim on Windows | |
| [ ] | P1 | [#47734](https://github.com/openclaw/openclaw/pull/47734) | fix: handle Windows schtasks "Last Result" key variant | |
| [ ] | P1 | [#46992](https://github.com/openclaw/openclaw/pull/46992) | Fix: Windows terminal encoding set to UTF-8 | |
| [ ] | P1 | [#45870](https://github.com/openclaw/openclaw/pull/45870) | fix: align windows path tests with runtime behavior | |
| [ ] | P1 | [#45860](https://github.com/openclaw/openclaw/pull/45860) | fix(build): prefer usable POSIX shells for Windows bundling | |
| [ ] | P1 | [#45380](https://github.com/openclaw/openclaw/pull/45380) | Make env-prefixed npm scripts work on Windows | |
| [ ] | P2 | [#44234](https://github.com/openclaw/openclaw/pull/44234) | docs(windows): note Git Bash requirement for A2UI builds | |
| [ ] | P2 | [#44228](https://github.com/openclaw/openclaw/pull/44228) | fix(reply): normalize Windows media paths for dedupe | |
| [ ] | P2 | [#44215](https://github.com/openclaw/openclaw/pull/44215) | fix(path): add Windows PATH bootstrap dirs | |
| [ ] | P2 | [#44211](https://github.com/openclaw/openclaw/pull/44211) | fix(build): use Git Bash wrapper for A2UI bundling on Windows | |
| [ ] | P2 | [#43624](https://github.com/openclaw/openclaw/pull/43624) | fix(gateway): fall back to PowerShell when wmic unavailable on Windows | |
| [ ] | P2 | [#43611](https://github.com/openclaw/openclaw/pull/43611) | decode Windows console output (GBK/CP936) | |
| [ ] | P2 | [#42174](https://github.com/openclaw/openclaw/pull/42174) | fix: false error of Windows path when binding host path to sandbox | |
| [ ] | P2 | [#39644](https://github.com/openclaw/openclaw/pull/39644) | fix(windows): PowerShell completion install and time-format detection | |
| [ ] | P2 | [#38932](https://github.com/openclaw/openclaw/pull/38932) | docs(gateway): add Windows no-Docker hardening fallback guide | |
| [ ] | P2 | [#38846](https://github.com/openclaw/openclaw/pull/38846) | security(windows): enhance command argument validation | |
| [ ] | P2 | [#37592](https://github.com/openclaw/openclaw/pull/37592) | fix(windows): handle spaces in Node.js path for plugin install | |
| [ ] | P2 | [#32602](https://github.com/openclaw/openclaw/pull/32602) | Tests: skip ios-team-id on Windows | |

---

## 5. WSL (Windows Subsystem for Linux) - Issues

| Resolved? | Priority | # | Title | Labels | Assignee |
|---|---|---|---|---|---|
| [ ] | P0 | [#47590](https://github.com/openclaw/openclaw/issues/47590) | Gateway binds on WSL2 but never responds to probe/health/TUI | | |
| [ ] | P1 | [#44180](https://github.com/openclaw/openclaw/issues/44180) | WSL2: os.networkInterfaces() can throw and crash gateway | | |
| [ ] | P1 | [#44051](https://github.com/openclaw/openclaw/issues/44051) | [skills] Skipping skill path error on WSL Environment | `bug` `regression` | |
| [ ] | P1 | [#43891](https://github.com/openclaw/openclaw/issues/43891) | Build failure on Windows: canvas:a2ui:bundle triggers WSL instead of Git Bash | `bug` `bug:crash` | |
| [ ] | P1 | [#42557](https://github.com/openclaw/openclaw/issues/42557) | exec host=node: path validation breaks cross-platform (WSL->Windows) | | |
| [ ] | P1 | [#31980](https://github.com/openclaw/openclaw/issues/31980) | [WSL2 Mirrored Mode] Gateway fails to start - "another gateway instance" error | `bug` `regression` | |
| [ ] | P2 | [#41553](https://github.com/openclaw/openclaw/issues/41553) | Surface diagnostics for Control UI auth in WSL2 + Windows setups | `enhancement` | |
| [ ] | P2 | [#34239](https://github.com/openclaw/openclaw/issues/34239) | windows 11 wsl ubtu | `enhancement` | |
| [ ] | P2 | [#20386](https://github.com/openclaw/openclaw/issues/20386) | Node host approval socket not responding on Windows/WSL | | |
| [ ] | P2 | [#16649](https://github.com/openclaw/openclaw/issues/16649) | WSL2: Control Windows browsers (Edge, Chrome) from OpenClaw | | |
| [ ] | P2 | [#7122](https://github.com/openclaw/openclaw/issues/7122) | DX Improvements for Windows/WSL2 Onboarding | `enhancement` | |
| [ ] | P2 | [#7057](https://github.com/openclaw/openclaw/issues/7057) | Flaky tests on Windows/WSL: timeouts and ENOENT | `enhancement` | |

### WSL - PRs

| Resolved? | Priority | # | Title | Assignee |
|---|---|---|---|---|
| [ ] | P1 | [#46698](https://github.com/openclaw/openclaw/pull/46698) | fix(auth): fix GitHub device flow polling and add --wait flag for WSL | |
| [ ] | P1 | [#44419](https://github.com/openclaw/openclaw/pull/44419) | fix(gateway): guard interface discovery failures on WSL | |
| [ ] | P1 | [#44129](https://github.com/openclaw/openclaw/pull/44129) | fix(skills): exempt managed skills from path escaping checks on WSL | |
| [ ] | P1 | [#44082](https://github.com/openclaw/openclaw/pull/44082) | fix: Skipping skill path error on WSL Environment | |
| [ ] | P2 | [#42857](https://github.com/openclaw/openclaw/pull/42857) | Tests: clear inherited WSL env in wsl detection test | |
| [ ] | P2 | [#33321](https://github.com/openclaw/openclaw/pull/33321) | fix(build): add WSL detection to bundle-a2ui.sh | |
| [ ] | P2 | [#31840](https://github.com/openclaw/openclaw/pull/31840) | Build: harden A2UI bundle for Windows+WSL shell path | |

---

## 6. Azure (Provider / Infrastructure) - Issues

| Resolved? | Priority | # | Title | Labels | Assignee |
|---|---|---|---|---|---|
| [ ] | P0 | [#48939](https://github.com/openclaw/openclaw/issues/48939) | tui/agent not working when Azure OpenAI endpoint is onboarded | `bug` | |
| [ ] | P1 | [#48107](https://github.com/openclaw/openclaw/issues/48107) | OpenAI SDK baseUrl query params silently dropped, breaking Azure OpenAI Responses API | | |
| [ ] | P1 | [#46971](https://github.com/openclaw/openclaw/issues/46971) | Azure OpenAI missing api-version query parameter causes 404 errors | | |
| [ ] | P1 | [#46676](https://github.com/openclaw/openclaw/issues/46676) | Azure OpenAI: api-version sent as header instead of query param causing 404 | | |
| [ ] | P1 | [#38784](https://github.com/openclaw/openclaw/issues/38784) | Azure OpenAI models report 0 context tokens | | |
| [ ] | P1 | [#37123](https://github.com/openclaw/openclaw/issues/37123) | Azure OpenAI provider not appearing during onboarding | `bug` `regression` | |
| [ ] | P1 | [#34241](https://github.com/openclaw/openclaw/issues/34241) | Intermittent no-tool execution after switching to azure-openai-responses | `bug` `regression` | |
| [ ] | P1 | [#32179](https://github.com/openclaw/openclaw/issues/32179) | Azure Foundry Anthropic: SSE stream events concatenated without delimiter | | |
| [ ] | P1 | [#28641](https://github.com/openclaw/openclaw/issues/28641) | Custom provider not accepting Azure Cognitive Service URL | `bug` | |
| [ ] | P2 | [#48116](https://github.com/openclaw/openclaw/issues/48116) | Phase 10: Fix dedicated ACA provisioning - env vars, retry logic | | |
| [ ] | P2 | [#48899](https://github.com/openclaw/openclaw/issues/48899) | Fix dedicated ACA worker: missing SystemAssigned identity | | |
| [ ] | P2 | [#36824](https://github.com/openclaw/openclaw/issues/36824) | Azure integration during onboarding/setup | `enhancement` | |
| [ ] | P2 | [#7249](https://github.com/openclaw/openclaw/issues/7249) | Support Claude Models via Azure service | `enhancement` | |
| [ ] | P3 | [#25058](https://github.com/openclaw/openclaw/issues/25058) | azure-responses sends rs_* reference when supportsStore=false *(stale)* | | |

### Azure - PRs

| Resolved? | Priority | # | Title | Assignee |
|---|---|---|---|---|
| [ ] | P1 | [#48267](https://github.com/openclaw/openclaw/pull/48267) | Azure models support (rebased) | |
| [ ] | P1 | [#47898](https://github.com/openclaw/openclaw/pull/47898) | docs: add Azure VM deployment guide with ARM templates | |
| [ ] | P1 | [#47285](https://github.com/openclaw/openclaw/pull/47285) | feat(memory-lancedb): native Azure OpenAI support | |
| [ ] | P1 | [#47181](https://github.com/openclaw/openclaw/pull/47181) | feat: add Azure Claude (AI Foundry) onboarding path | |
| [ ] | P1 | [#46760](https://github.com/openclaw/openclaw/pull/46760) | fix(azure): ensure api-version is sent as query param not header | |
| [ ] | P1 | [#39540](https://github.com/openclaw/openclaw/pull/39540) | Add support for Azure models (GPT-5.4 and more) | |
| [ ] | P1 | [#37717](https://github.com/openclaw/openclaw/pull/37717) | feat: add Azure api-version support for OpenAI-compatible chat | |
| [ ] | P2 | [#25166](https://github.com/openclaw/openclaw/pull/25166) | Docs: add Azure OpenAI provider guide | |
| [ ] | P3 | [#25758](https://github.com/openclaw/openclaw/pull/25758) | Feat/azure ai provider *(stale)* | |
| [ ] | P3 | [#17970](https://github.com/openclaw/openclaw/pull/17970) | Copilot/refactor serverless azure function *(stale)* | |
| [ ] | P3 | [#12059](https://github.com/openclaw/openclaw/pull/12059) | feat(agents): Add Azure AI Foundry credential support *(stale)* | |

---

## 7. Microsoft 365 / SharePoint - Issues

| Resolved? | Priority | # | Title | Labels | Assignee |
|---|---|---|---|---|---|
| [ ] | P2 | [#30299](https://github.com/openclaw/openclaw/issues/30299) | Microsoft SharePoint and Openclaw | `enhancement` | |
| [ ] | P2 | [#30023](https://github.com/openclaw/openclaw/issues/30023) | Native Microsoft 365 integration (like gog for Google Workspace) | `enhancement` | |
| [ ] | P3 | [#40439](https://github.com/openclaw/openclaw/issues/40439) | ClawHub skill review pending: sharepoint-by-altf1be | | |

---

## Appendix: Quick Filters for Maintainers

**All P0 items (start here):**
- [#44857](https://github.com/openclaw/openclaw/issues/44857) - Broken bundled msteams extension
- [#43648](https://github.com/openclaw/openclaw/issues/43648) - MS Teams inline images crash
- [#48832](https://github.com/openclaw/openclaw/issues/48832) - Windows CHANNEL_IDS not iterable
- [#48756](https://github.com/openclaw/openclaw/issues/48756) - Windows gateway restart/stop fail
- [#48736](https://github.com/openclaw/openclaw/issues/48736) - Windows WebSocket 80% failure
- [#47590](https://github.com/openclaw/openclaw/issues/47590) - WSL2 gateway unresponsive
- [#48939](https://github.com/openclaw/openclaw/issues/48939) - Azure OpenAI endpoint broken
- [#48659](https://github.com/openclaw/openclaw/pull/48659) - PR: MSTeams harden integration (XL)

**All stale items (consider closing):**
Issues: #28014, #26599, #24797, #17783, #15622, #14436, #19908, #25856, #25376, #24441, #23612, #23509, #23109, #21990, #21678, #16323, #26160, #25058
PRs: #27765, #26274, #25511, #8964, #25758, #17970, #12059
