# Microsoft Ecosystem Issues & PRs Tracker

> **Purpose:** Living checklist for maintainers to track all open Microsoft-related issues and PRs (Teams, Windows, WSL, Azure, M365/SharePoint).
>
> **How to use:**
>
> - Mark items resolved by editing this PR body and changing `[ ]` to `[x]`
> - Claim items by adding your GitHub handle to the `Assignee` column
> - Priority guide: **P0** = crash/blocker, **P1** = significant bug/regression, **P2** = minor bug/enhancement, **P3** = nice-to-have/stale
> - Items marked _(stale)_ have been flagged by the stale bot due to inactivity
>
> **Last updated:** 2026-04-08 (refreshed: #62713, #62715, #62716 merges)

---

## Summary

| Category                   | Issues  | PRs     | Total   | Closed  | Remaining |
| -------------------------- | ------- | ------- | ------- | ------- | --------- |
| MS Teams (channel plugin)  | 66      | 76      | 142     | 102     | 40        |
| Windows (platform)         | 125     | 52      | 177     | 49      | 128       |
| WSL                        | 17      | 12      | 29      | 13      | 16        |
| Azure (provider/infra)     | 20      | 23      | 43      | 18      | 25        |
| Microsoft 365 / SharePoint | 3       | 0       | 3       | 2       | 1         |
| **Total**                  | **231** | **163** | **394** | **184** | **210**   |

---

## 1. MS Teams Channel Plugin — Issues

### Bugs / Crashes

| Resolved? | Priority | #      | Title                                                                                                             | Labels               | Assignee   |
| --------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------- | -------------------- | ---------- |
| [x]       | P0       | #55250 | [Bug]: msteams plugin crash-loops due to path-to-regexp v8 incompatibility in @microsoft/teams.apps               | `bug`                |            |
| [x]       | P0       | #54960 | [msteams] path-to-regexp v8 breaking: /api\* wildcard in Bot Framework CloudAdapter                               | `bug`                |            |
| [x]       | P0       | #54889 | [msteams] Teams SDK migration breaks on path-to-regexp v8+ — /api\* wildcard pattern rejected                     | `bug`                |            |
| [x]       | P0       | #54852 | [msteams] Channel fails to start on 2026.3.24 — pathToRegexp "Missing parameter name at index 5: /api\*"          | `bug`                |            |
| [x]       | P0       | #54703 | [Bug]: Teams Broken After 2026.3.24 updates                                                                       | `bug`                |            |
| [x]       | P0       | #54755 | v2026.3.24: Two breaking changes — Express 5 route regression + duplicate plugin infinite loop                    | `bug`                |            |
| [x]       | P0       | #53953 | [Bug]: msteams plugin crashes on startup — module singleton mismatch / ships uncompiled TypeScript                | `bug`                |            |
| [x]       | P0       | #44857 | Broken bundled msteams extension                                                                                  | `bug` `bug:crash`    |            |
| [x]       | P0       | #43648 | MS Teams: inline pasted images fail to download (hostedContents contentBytes always null)                         | `bug` `bug:crash`    |            |
| [x]       | P1       | #56040 | msteams: Teams streaming protocol causes lost messages with tool-using agents                                     | `bug`                | @BradGroux |
| [x]       | P1       | #56041 | msteams: blockStreaming config has no effect (onBlockReply not wired)                                             | `bug`                | @BradGroux |
| [x]       | P1       | #58601 | msteams: streaming + block delivery duplicate text when response exceeds 4000 chars                               | `bug`                | @jlian     |
| [ ]       | P1       | #58774 | [Bug] Microsoft Teams: HTTP 403 on proactive messages in v2026.3.31 + RSC consent blocks bot installation in team | `bug`                |            |
| [ ]       | P1       | #58617 | [Bug]: msteams channel file attachments not downloaded — Graph fallback triggers on non-file HTML attachments     |                      |            |
| [x]       | P1       | #58615 | [Bug]: msteams channel threads share the same session key (cross-thread context bleed)                            |                      |            |
| [ ]       | P1       | #58249 | [Bug]: Teams webhook broken in 2026.3.24+: publicUrl removed breaks JWT validation                                | `bug` `regression`   |            |
| [x]       | P1       | #58030 | fix(msteams): channel thread replies land as top-level posts or in wrong thread                                   |                      |            |
| [ ]       | P1       | #58001 | [Bug] Cron announce delivery rejects valid Microsoft Teams conversation IDs                                       |                      |            |
| [ ]       | P1       | #56479 | msteams plugin: path-to-regexp crash on gateway 2026.3.24 + Node.js 25.8.2                                        |                      |            |
| [x]       | P2       | #56380 | msteams: Double typing indicator in Teams DMs                                                                     |                      |            |
| [ ]       | P1       | #56108 | Microsoft Teams channel crashes on startup in OpenClaw 2026.3.24                                                  |                      |            |
| [ ]       | P1       | #59731 | MSTeams: streaming reply drops during long tool chains (30s+)                                                     | `bug`                |            |
| [x]       | P1       | #56603 | msteams plugin: three stacked bugs prevent inbound Teams webhooks on v2026.3.24                                   | `bug`                | @BradGroux |
| [x]       | P1       | #55384 | [msteams] Adaptive Card Action.Submit invoke activities silently dropped                                          |                      |            |
| [ ]       | P1       | #55386 | [msteams] Bot-to-user file upload via message send --media fails — fileConsent callback not handled               |                      |            |
| [ ]       | P1       | #55383 | [msteams] Inbound media from OneDrive/SharePoint shared links fails — graph media fetch empty                     |                      |            |
| [x]       | P1       | #53911 | [Bug]: msteams agent unaware of message delivery failure — silently drops errors                                  | `bug`                |            |
| [x]       | P1       | #53910 | [Bug]: msteams typing/send errors logged as [object Object] — error not stringified                               | `bug`                |            |
| [x]       | P1       | #54520 | [Bug]: MSTeams DM replies leak to team channel — lastChannel routing race + reply_to_current fragility            | `bug`                |            |
| [x]       | P1       | #54670 | [Bug]: msteams runtime supports feedback/welcome config keys but schema rejects them                              | `bug`                |            |
| [x]       | P1       | #53184 | msteams: typing indicator hits 429 rate limit during long agent runs                                              | `bug`                |            |
| [x]       | P1       | #52954 | [Bug]: MS Teams channel thread replies post as top-level messages instead of in the thread                        | `bug`                |            |
| [ ]       | P1       | #51749 | MS Teams: graph media fetch empty for channel file attachments despite valid permissions and token                | `bug`                |            |
| [x]       | P1       | #43323 | MS Teams pairing drops first DM before saving conversation reference, so --notify always fails                    | `bug` `bug:behavior` |            |
| [ ]       | P1       | #47268 | [msteams] FileConsentCard not updated after user accepts — consent card remains frozen                            |                      |            |
| [x]       | P1       | #38629 | msteams implicit mention fails — replyToId unreliable, threadRootId not used as fallback                          |                      |            |
| [x]       | P1       | #35822 | MS Teams DM file attachments fail: Graph API chatId format mismatch and messageId encoding error                  |                      |            |
| [x]       | P1       | #29379 | MS Teams plugin drops all text blocks after the first in multi-block replies                                      |                      |            |
| [x]       | P1       | #29847 | fix(msteams): FileConsent upload succeeds but FileInfoCard fails — TurnContext proxy revoked                      |                      |            |
| [x]       | P1       | #27885 | msteams provider exits immediately, causing infinite auto-restart loop                                            |                      |            |
| [x]       | P1       | #25790 | msteams plugin: duplicate provider start causes EADDRINUSE crash loop (bundled + standalone conflict)             |                      |            |
| [x]       | P1       | #24148 | Cross-channel reply context leak — Teams DM overwrites session reply target                                       | `bug`                |            |
| [x]       | P1       | #24088 | Plugin MSTeams en OpenClaw                                                                                        | `bug`                |            |
| [x]       | P1       | #23453 | MS Teams: Inline images (Ctrl+V) in DMs not downloaded — Graph fallback fails                                     |                      |            |
| [x]       | P1       | #22169 | msteams provider starts twice on gateway boot, causing EADDRINUSE restart loop                                    | `bug`                |            |
| [ ]       | P1       | #52558 | pnpm check fails on main with tsgo errors in irc/mattermost/msteams/nextcloud-talk                                | `maintainer`         |            |
| [x]       | P2       | #51568 | msteams: add OpenClaw User-Agent header to Microsoft backend HTTP calls                                           |                      |            |
| [x]       | P2       | #50835 | Docs: inconsistent 'MS Teams' vs 'Microsoft Teams' naming                                                         |                      |            |
| [x]       | P2       | #28014 | [msteams] Inline image downloads fail in 1:1 chats — bot adapter token instead of MSAL Graph token _(stale)_      | `stale`              |            |
| [x]       | P2       | #26599 | [MSTeams] Regular messages falsely detected as `<media:document>` _(stale)_                                       | `stale`              |            |
| [x]       | P2       | #24797 | MSTeams: Image attachments not downloaded in bot DM chats (3 bugs) _(stale)_                                      | `stale`              |            |
| [x]       | P2       | #17783 | Microsoft Teams channel setup fails on OpenClaw (Raspberry Pi) _(stale)_                                          | `bug` `stale`        |            |
| [x]       | P2       | #15622 | Teams extension deps wiped on every global npm update _(stale)_                                                   | `stale`              |            |
| [x]       | P2       | #14436 | Gateway JWT middleware blocks Bot Framework webhooks in msteams plugin _(stale)_                                  | `bug` `stale`        |            |

### Feature Requests

| Resolved? | Priority | #      | Title                                                                            | Labels        | Assignee |
| --------- | -------- | ------ | -------------------------------------------------------------------------------- | ------------- | -------- |
| [x]       | P1       | #54626 | msteams: Fetch thread/chat history from Graph API on session restart             | `enhancement` |          |
| [ ]       | P2       | #54932 | feat(msteams): Auto-inject thread context when message arrives as thread reply   | `enhancement` |          |
| [x]       | P2       | #60746 | Microsoft Teams: add config option to disable typing indicator before replies    |               |          |
| [x]       | P2       | #60732 | MS Teams plugin: migrate from deprecated HttpPlugin to httpServerAdapter         |               |          |
| [x]       | P2       | #52501 | [Feature]: Team Channels                                                         | `enhancement` |          |
| [x]       | P2       | #51806 | msteams: implement Teams AI agent UX best practices                              | `enhancement` |          |
| [x]       | P2       | #40865 | feat(msteams): Implement read and search message actions for Teams channel       |               |          |
| [ ]       | P2       | #40855 | Support federated credentials / managed identity for MS Teams Bot Framework auth |               |          |
| [x]       | P2       | #13243 | msteams support resumable Graph upload session for files >4MB                    | `enhancement` |          |
| [x]       | P2       | #11346 | feat(msteams): Add Graph API-based message history query (readMessages action)   | `enhancement` |          |
| [x]       | P2       | #7031  | Simplify Teams integration for M365-only organizations (no Azure subscription)   | `enhancement` |          |
| [x]       | P3       | #19908 | WhatsApp Channel Reliability Issues — Migration to Teams Graph _(stale)_         | `stale`       |          |

---

## 2. MS Teams Channel Plugin — PRs

| Resolved? | Priority | #      | Title                                                                                     | Size | Assignee            |
| --------- | -------- | ------ | ----------------------------------------------------------------------------------------- | ---- | ------------------- |
| [x]       | P1       | #56071 | fix(msteams): reset stream state after tool calls to prevent message loss                 | S    | @BradGroux          |
| [x]       | P1       | #56134 | fix(msteams): add blockStreaming config and progressive delivery                          | M    | @BradGroux          |
| [x]       | P1       | #59297 | fix(msteams): prevent duplicate text when stream exceeds 4000 char limit                  | XS   | @BradGroux          |
| [x]       | P2       | #59321 | fix(msteams): use formatUnknownError instead of String(err) for error logging             | XS   | @BradGroux          |
| [x]       | P1       | #56631 | fix(msteams): accept strict Bot Framework and Entra service tokens                        | S    | @BradGroux          |
| [x]       | P1       | #55108 | fix(msteams): align feedback invoke authorization                                         | L    | @jacobtomlinson     |
| [x]       | P0       | #55440 | fix(msteams): prevent path-to-regexp crash with express 5 (#55161)                        | S    | @lml2468            |
| [x]       | P1       | #55198 | fix(msteams): preserve channel reply threading in proactive fallback                      | S    | @hyojin             |
| [x]       | P2       | #56608 | fix(msteams): preserve thread context in proactive fallback for channel conversations     | S    | @tazmon95           |
| [x]       | P1       | #59937 | fix(msteams): re-land revoked-context proactive fallback                                  | S    | @BradGroux          |
| [x]       | P1       | #60430 | fix(msteams): inject system event on message delivery failure                             | S    | @BradGroux          |
| [x]       | P1       | #60431 | fix(msteams): handle Adaptive Card Action.Submit invoke activities                        | M    | @BradGroux          |
| [x]       | P1       | #60432 | fix(msteams): persist conversation reference during DM pairing                            | S    | @BradGroux          |
| [x]       | P2       | #60433 | feat(msteams): add OpenClaw User-Agent header to Microsoft HTTP calls                     | M    | @BradGroux          |
| [x]       | P2       | #60771 | msteams: add typingIndicator config and prevent duplicate DM typing indicator             | S    | @BradGroux          |
| [x]       | P2       | #60939 | fix(msteams): replace deprecated HttpPlugin with httpServerAdapter                        | S    | @coolramukaka-sys   |
| [x]       | P0       | #54965 | msteams: bump @microsoft/teams.\* to 2.0.6 to fix pathToRegexp error                      | XS   | @MerlinMiao88888888 |
| [x]       | P0       | #54880 | fix(msteams): patch Teams HttpPlugin /api\* route pattern in dist                         | S    |                     |
| [x]       | P0       | #54866 | msteams: bump @microsoft/teams.apps to 2.0.6 to fix pathToRegexp error                    | XS   |                     |
| [ ]       | P0       | #48659 | MSTeams: harden channel integration and readable focus labels                             | XL   |                     |
| [x]       | P1       | #54832 | msteams: add search message action                                                        | M    |                     |
| [x]       | P1       | #54702 | fix(msteams): prefer freshest personal conversation for proactive DM sends                | S    |                     |
| [x]       | P1       | #54679 | fix: allow msteams feedback and welcome config keys                                       | XS   |                     |
| [x]       | P1       | #54424 | chore(msteams): bump @microsoft/teams.apps from 2.0.5 to 2.0.6                            | XS   |                     |
| [ ]       | P1       | #53615 | feat(msteams): add federated credential support (certificate + managed identity)          | M    |                     |
| [x]       | P1       | #53458 | fix(msteams): prefer personal conversation in findByUserId to prevent DM misrouting       | S    |                     |
| [ ]       | P1       | #53432 | msteams: add message actions — pin, unpin, read, react, reactions                         | L    |                     |
| [x]       | P1       | #53188 | fix(msteams): throttle typing indicator to prevent 429 rate limit spiral                  | S    |                     |
| [x]       | P1       | #52212 | fix(msteams): download DM inline images via Graph API                                     | M    |                     |
| [x]       | P1       | #51808 | msteams: implement Teams AI agent UX best practices                                       | M    |                     |
| [x]       | P1       | #51647 | msteams: extract structured quote/reply context                                           | S    |                     |
| [ ]       | P1       | #51646 | msteams: add reaction support (inbound + outbound)                                        | M    |                     |
| [x]       | P1       | #51643 | msteams: fetch thread history via Graph API for channel replies                           | M    |                     |
| [x]       | P1       | #50863 | fix: standardize 'MS Teams' to 'Microsoft Teams' across docs                              | S    |                     |
| [x]       | P1       | #50214 | fix(msteams): pass teamId and teamName to resolveAgentRoute() [AI-assisted]               | S    |                     |
| [ ]       | P1       | #48014 | feat(msteams): add DefaultAzureCredential auth type for passwordless Teams auth           | L    |                     |
| [ ]       | P1       | #47934 | fix(msteams): address review feedback on #40884 — schema, types, env validation _(draft)_ | M    |                     |
| [x]       | P1       | #47860 | fix(msteams): add fetch timeout to Microsoft Graph API calls                              | XS   |                     |
| [ ]       | P1       | #49580 | fix(msteams): update FileConsentCard after user accepts upload                            | M    | @sudie-codes        |
| [x]       | P1       | #57528 | msteams: add member-info action                                                           | XS   | @sudie-codes        |
| [x]       | P1       | #57529 | msteams: add channel-list and channel-info actions                                        | XS   | @sudie-codes        |
| [ ]       | P1       | #57530 | msteams: add participant removal support                                                  | S    | @sudie-codes        |
| [x]       | P1       | #47270 | fix(msteams): update FileConsentCard in-place after upload via updateActivity             | S    |                     |
| [x]       | P1       | #44899 | fix: add missing @microsoft/agents-hosting dependency for msteams extension               | S    |                     |
| [ ]       | P1       | #44739 | feat(msteams): extract structured quote/reply context from HTML attachments               | M    |                     |
| [ ]       | P1       | #43934 | fix(msteams): persist conversation reference during DM pairing                            | S    |                     |
| [x]       | P1       | #43761 | fix(msteams): add @microsoft/agents-hosting to root dependencies                          | XS   |                     |
| [ ]       | P1       | #43414 | fix(msteams): persist first-DM conversation reference in pairing path                     | S    |                     |
| [x]       | P1       | #43326 | feat(msteams): fetch thread history via Graph API for channel replies                     | M    |                     |
| [ ]       | P1       | #43190 | MS Teams: add channel archive persistence and deleted-channel cleanup                     | XL   |                     |
| [ ]       | P1       | #41565 | feat(cards): add shared adaptive card rendering for all channels                          | XL   |                     |
| [ ]       | P1       | #42350 | feat(cards): adaptive card rendering for iOS/macOS (SwiftUI)                              | L    |                     |
| [ ]       | P1       | #42307 | feat(cards): adaptive card rendering for web UI (Lit element)                             | XL   |                     |
| [ ]       | P1       | #42304 | feat(cards): adaptive card rendering for Android (Jetpack Compose)                        | L    |                     |
| [ ]       | P2       | #41908 | docs(plugins): adaptive cards concept documentation                                       | M    |                     |
| [x]       | P2       | #41735 | docs(plugins): add adaptive cards to community plugins listing                            | XS   |                     |
| [ ]       | P1       | #41108 | fix(msteams): detect implicit mentions in thread replies via conversation.id              | S    |                     |
| [ ]       | P1       | #40884 | feat(msteams): support federated credentials and certificate auth _(draft)_               | S    |                     |
| [ ]       | P1       | #40463 | fix(msteams): fix image attachment download for channel and DM messages                   | M    |                     |
| [x]       | P1       | #39352 | fix(msteams): pass teamId into inbound route resolution                                   | S    |                     |
| [x]       | P2       | #37853 | feat(msteams): add Teams reaction support                                                 | M    |                     |
| [ ]       | P2       | #34581 | fix(msteams): handle invalid JSON escape sequences in Bot Framework activities            | M    |                     |
| [ ]       | P2       | #34532 | docs: add Teams academic chat Canvas MVP host-side guide                                  | XS   |                     |
| [x]       | P2       | #33343 | fix(msteams): sanitize error messages sent to users (CWE-209)                             | XS   |                     |
| [ ]       | P2       | #32558 | MSTeams: add upload session fallback for large files                                      | M    |                     |
| [x]       | P2       | #32555 | fix(msteams): clear pending upload timeout on removal                                     | XS   |                     |
| [ ]       | P2       | #30142 | feat(adapters): add sendPayload to batch-b (includes MS Teams)                            | L    |                     |
| [x]       | P2       | #23596 | fix(msteams): add SSRF validation to file consent upload URL                              | M    | @BradGroux          |
| [x]       | P2       | #22325 | fix(security): prevent memory exhaustion in inline image decoding                         | S    |                     |
| [ ]       | P2       | #21739 | feat(msteams): support resumable upload sessions for files > 4MB                          | S    |                     |
| [ ]       | P2       | #18716 | msteams: fix DM image delivery + user target routing                                      | S    |                     |
| [x]       | P3       | #27765 | msteams: allow replyStyle config override for DMs _(stale)_                               | XS   |                     |
| [x]       | P3       | #26668 | MSTeams: add upload session fallback for large files                                      | L    |                     |
| [x]       | P3       | #26274 | msteams: fix image download auth, double-counting, and typing indicator _(stale)_         | M    |                     |
| [x]       | P3       | #25511 | fix(msteams): suppress reasoning-only text in outbound rendering _(stale)_                | XS   |                     |
| [x]       | P3       | #8964  | test(msteams): add comprehensive tests for graph-upload module _(stale)_                  |      |                     |

---

## 3. Windows Platform — Issues

### Installation / Setup / Gateway

| Resolved? | Priority | #      | Title                                                                                              | Assignee  |
| --------- | -------- | ------ | -------------------------------------------------------------------------------------------------- | --------- |
| [x]       | P0       | #54801 | [Bug]: The openclaw gateway can't start in Windows                                                 |           |
| [x]       | P0       | #48832 | [Windows] Module initialization error: CHANNEL_IDS not iterable on startup                         |           |
| [x]       | P0       | #48756 | Gateway restart/stop commands fail on Windows, causing connection loss                             |           |
| [x]       | P0       | #48736 | CLI WebSocket handshake timeout on Windows (~80% failure rate)                                     |           |
| [x]       | P0       | #60061 | fix: import CHANNEL_IDS from leaf module to avoid TDZ on init (#48832)                             | PR merged |
| [x]       | P0       | #60075 | fix: improve WS handshake reliability on slow-startup environments (#48736)                        | PR merged |
| [x]       | P0       | #60085 | fix: default gateway.mode to "local" when unset (#54801)                                           | PR merged |
| [x]       | P0       | #60094 | test: update gateway.mode test for default-to-local behavior (#54801)                              | PR merged |
| [ ]       | P1       | #54751 | Feature: Windows-compatible Update button (stop gateway before npm update)                         |           |
| [ ]       | P1       | #54437 | [Bug]: Windows Playwright CDP integration bug                                                      |           |
| [ ]       | P1       | #54039 | [Bug]: read tool prepends workspace root to absolute Windows paths, producing doubled paths        |           |
| [ ]       | P1       | #53668 | gateway status reports unknown / staleGatewayPids on localized Chinese Windows                     |           |
| [ ]       | P1       | #53539 | [Feature]: New openclaw-for-windows repository under openclaw org                                  |           |
| [ ]       | P1       | #53474 | Bug: openclaw gateway status false positive on Windows due to setlocal batch parsing bug           |           |
| [ ]       | P1       | #53226 | [Windows] exec launcher broken on Windows-native: all commands quoted as PS string literals        |           |
| [ ]       | P1       | #52952 | Windows Telegram execs fail in allowlist/command-rebuild path                                      |           |
| [ ]       | P1       | #52525 | [Windows] Native file dialog invisible to browser-automation — exec+PowerShell workaround          |           |
| [ ]       | P1       | #52424 | cron create/list fails with 'gateway closed (1000)' handshake timeout on Windows                   |           |
| [ ]       | P1       | #52180 | [Bug]: Podman Windows WSL permission denied                                                        |           |
| [ ]       | P1       | #52093 | Windows: EPERM error on atomic write to devices/pending.json (file lock race condition)            |           |
| [ ]       | P1       | #52049 | Bug: gateway stop doesn't terminate node.exe process on Windows                                    |           |
| [ ]       | P1       | #52044 | Bug: gateway restart spawns duplicate processes on Windows (3 windows)                             |           |
| [ ]       | P1       | #52022 | [Bug] Windows skill path compaction mixes separators and causes wrong read paths                   |           |
| [ ]       | P1       | #51837 | Windows: exec spawns steal focus from active window                                                |           |
| [ ]       | P1       | #51797 | Bug: Exec command parameter spaces lost on Windows                                                 |           |
| [ ]       | P1       | #51519 | Windows: channel /restart still fails even when CLI gateway restart works                          |           |
| [ ]       | P1       | #50519 | [Bug]: Windows exec tool produces garbled Chinese characters due to hardcoded UTF-8 encoding       |           |
| [ ]       | P1       | #50472 | [Windows] Gateway exits silently without crash log                                                 |           |
| [ ]       | P1       | #50453 | Memory Search FTS5 unavailable on Windows due to node:sqlite missing FTS5 module                   |           |
| [x]       | P1       | #50403 | [Bug]: Regression of #25376 - Exec allowlist returns 'unsupported platform' on Windows             |           |
| [ ]       | P1       | #50380 | [Bug]: CLI WebSocket handshake timeout when gateway is running (v2026.3.13, Windows)               |           |
| [x]       | P1       | #50352 | [Bug]: acpx fails to spawn Claude CLI on Windows                                                   |           |
| [ ]       | P1       | #50251 | Windows: Feishu channel fails with 'Feishu runtime not initialized'                                |           |
| [ ]       | P1       | #48780 | [Windows] exec() and read() commands corrupted with `</arg_value>>` suffix                         |           |
| [ ]       | P1       | #48461 | Intermittent browser command failures on Windows (gateway closed, handshake timeout)               |           |
| [ ]       | P1       | #48079 | LINE plugin /line/webhook returns 404 on Windows                                                   |           |
| [ ]       | P1       | #48043 | Chrome User Profile Attach Broken on Windows                                                       |           |
| [ ]       | P1       | #47957 | CI check/startup-memory/windows-tests globally broken                                              |           |
| [ ]       | P1       | #47748 | Windows: `openclaw update` fails with `spawn EINVAL`                                               |           |
| [ ]       | P1       | #47643 | Persistent Telegram Channel Issues on Windows                                                      |           |
| [ ]       | P1       | #47484 | openclaw_supervisor.ps1: unquoted paths break on Windows usernames with spaces                     |           |
| [ ]       | P1       | #47445 | gateway restart command fails when executed via exec tool on Windows                               |           |
| [ ]       | P1       | #46378 | Installation config UI freezes on Windows                                                          |           |
| [ ]       | P1       | #45940 | False negative from `openclaw gateway probe` on Windows                                            |           |
| [ ]       | P1       | #45275 | `pnpm ui:build` fails: can't find `C:\\Program` on Windows                                         |           |
| [ ]       | P1       | #44559 | Windows: Gateway disconnects when PowerShell window closes                                         |           |
| [ ]       | P1       | #44199 | Windows: ENOENT mkdir error in Telegram handler                                                    |           |
| [ ]       | P1       | #43943 | [Windows] Gateway fails to start with Chinese username path                                        |           |
| [ ]       | P1       | #43180 | No hooks found — Windows pnpm install                                                              |           |
| [ ]       | P1       | #42839 | Windows: openclaw agent --local returns 401 after clean reset                                      |           |
| [ ]       | P1       | #42556 | Plugin install fails on Windows with spawn EINVAL                                                  |           |
| [ ]       | P1       | #41797 | install.ps1 forcefully exits PowerShell on systems without winget                                  |           |
| [ ]       | P1       | #40684 | npm install fails on Windows: git permission denied for libsignal-node                             |           |
| [ ]       | P1       | #40613 | Windows 11 exec Chinese output becomes mojibake                                                    |           |
| [ ]       | P1       | #40551 | [Windows + pnpm] Gateway dashboard returns 404 after upgrading                                     |           |
| [ ]       | P1       | #40540 | `openclaw update` fails with EBUSY error on Windows                                                |           |
| [ ]       | P1       | #40340 | bug(acpx): Windows console windows flash on every ACP spawn                                        |           |
| [x]       | P1       | #40108 | Dashboard returns 404 on Windows with pnpm global install                                          |           |
| [ ]       | P1       | #39758 | OpenClaw 2026.3.7 Windows Setup Failure                                                            |           |
| [ ]       | P1       | #39057 | `openclaw node status` reports "stopped" on German Windows                                         |           |
| [ ]       | P1       | #38054 | Windows install fails and immediately closes Powershell                                            |           |
| [ ]       | P1       | #37563 | `openclaw plugins install` fails on Windows when Node.js path contains spaces                      |           |
| [ ]       | P1       | #37036 | In Windows, opening dashboard shows "Not Found"                                                    |           |
| [ ]       | P1       | #35807 | Exec tool corrupts PowerShell pipeline variables on Windows                                        |           |
| [ ]       | P1       | #35796 | Windows node onboarding: no --token flag, config overwritten on restart                            |           |
| [ ]       | P1       | #35297 | Control UI: Tools toggles don't persist / Save disabled on Windows                                 |           |
| [ ]       | P1       | #34189 | Control UI / Dashboard returns "Not Found" on Windows                                              |           |
| [ ]       | P1       | #34092 | Chat "copy button" not working on Windows                                                          |           |
| [ ]       | P1       | #33862 | Feishu groupPolicy allowlist not working on Windows                                                |           |
| [ ]       | P1       | #33514 | bug(acpx): resolveWindowsSpawnProgramCandidate is not a function                                   |           |
| [ ]       | P1       | #31175 | Windows Node: exec-approvals socket not created automatically                                      |           |
| [ ]       | P1       | #30973 | MEDIA: token parser rejects Windows drive-letter paths                                             |           |
| [ ]       | P1       | #30072 | Windows: CLI startup regression ~14s vs ~3s                                                        |           |
| [ ]       | P1       | #29949 | /restart command fails on Windows: missing schtasks support                                        |           |
| [x]       | P1       | #29305 | Windows: acpx plugin binary verification fails under Scheduled Task                                |           |
| [x]       | P1       | #29134 | ACP runtime backend reports unavailable on Windows                                                 |           |
| [x]       | P1       | #28625 | Gemini CLI detection fails on Windows (npm global path mismatch)                                   |           |
| [x]       | P1       | #28551 | Dashboard shows incorrect status on Windows: Version n/a, Health Offline                           |           |
| [x]       | P1       | #28283 | Exec approval gating intermittent on Windows                                                       |           |
| [ ]       | P1       | #59708 | exec-approvals: `ask: off` / `security: full` not respected on Windows                             |           |
| [x]       | P1       | #59774 | Windows exec approval broken (Chinese-language dupe of #59708)                                     |           |
| [ ]       | P1       | #59702 | sessions_spawn RPC fails with 'pairing required' on Windows Server 2025                            |           |
| [x]       | P1       | #59617 | Windows: allowFrom + security: standard does not enable auto-approval for remote commands          |           |
| [x]       | P1       | #59481 | Windows exec allowlist auto-execution not supported on win32                                       |           |
| [x]       | P1       | #28270 | Fix version mismatch & zombie process on Windows                                                   |           |
| [ ]       | P2       | #54669 | [Field Report] Chrome 136+ binds CDP to [::1] (IPv6) on Windows — portproxy v4tov4 breaks silently |           |
| [ ]       | P2       | #54470 | [Bug]: openclaw webhooks gmail setup fails on native Windows with `Error: spawn gcloud ENOENT`     |           |
| [ ]       | P2       | #48689 | google-vertex auth broken on Windows in 2026.3.13                                                  |           |
| [ ]       | P2       | #47053 | tts.test.ts mock missing — Windows CI fails                                                        |           |
| [ ]       | P2       | #45529 | Support stdin/file input for config set (PowerShell quote issues)                                  |           |
| [x]       | P2       | #44487 | exec host=node broken from Mac gateway after 2026.3.11                                             |           |
| [ ]       | P2       | #44362 | fix(backup): .backupignore permission check false-positives on Windows                             |           |
| [ ]       | P2       | #44361 | fix(backup): archive integrity cross-check fails on Windows                                        |           |
| [ ]       | P2       | #44293 | Make `pnpm check:docs` work in native PowerShell                                                   |           |
| [ ]       | P2       | #43931 | MEMORY.md injected twice on Windows NTFS (case-insensitive)                                        |           |
| [ ]       | P2       | #41800 | Gemini CLI OAuth broken on Windows (nvm)                                                           |           |
| [ ]       | P2       | #38809 | [Windows] Image payload missing for google-generative-ai                                           |           |
| [ ]       | P2       | #37426 | Reply media dedupe should normalize Windows local paths                                            |           |
| [ ]       | P2       | #30878 | Flaky Windows CI test in path-safety                                                               |           |
| [ ]       | P2       | #30403 | google-gemini-cli-auth OAuth fails on Windows                                                      |           |
| [x]       | P2       | #25399 | tools.exec.pathPrepend replaces PATH entirely on Windows                                           |           |
| [x]       | P2       | #25282 | install on windows                                                                                 |           |
| [x]       | P2       | #22851 | Windows: exec tool creates visible console windows (conhost flash)                                 |           |
| [x]       | P2       | #22554 | Telegram voice not auto-transcribed on Windows                                                     |           |
| [x]       | P2       | #19819 | SIGUSR1 restart crashes on Windows: EBADF bad file descriptor                                      |           |
| [x]       | P2       | #16821 | exec tool mangles PowerShell $ syntax on Windows                                                   |           |
| [x]       | P2       | #5440  | Error when installing via CMD on Windows 11                                                        |           |
| [x]       | P3       | #25856 | Windows: cmd.exe window flashes every ~30s from ARP scanning _(stale)_                             |           |
| [x]       | P3       | #25376 | Exec allowlist returns 'unsupported platform' on Windows _(stale)_                                 |           |
| [x]       | P3       | #24441 | P0 Windows reliability: stale lock, cron EPERM, single-instance guard _(stale)_                    |           |
| [x]       | P3       | #23612 | OpenClaw installation fails on Windows _(stale)_                                                   |           |
| [x]       | P3       | #23509 | SIGUSR1 restart creates orphaned process as Scheduled Task _(stale)_                               |           |
| [x]       | P3       | #23109 | Silent failure sending local media on Windows via Telegram _(stale)_                               |           |
| [x]       | P3       | #21990 | Exec Tool on Windows does not capture stdout/stderr _(stale)_                                      |           |
| [x]       | P3       | #21678 | Windows: missing windowsHide:true on child*process.spawn *(stale)\_                                |           |
| [x]       | P3       | #16323 | Security: Insecure Default Tool Policies + Windows Command Injection _(stale)_                     |           |

### Feature Requests

| Resolved? | Priority | #      | Title                                                            | Assignee |
| --------- | -------- | ------ | ---------------------------------------------------------------- | -------- |
| [ ]       | P2       | #44038 | [Proposal] Windows Quick Installer GUI                           |          |
| [ ]       | P2       | #38799 | Windows automation skills — bridging the platform gap            |          |
| [ ]       | P2       | #39821 | Add Ctrl+Enter (Windows) shortcut to send messages in Control UI |          |
| [ ]       | P2       | #18985 | Supports Windows 11 MSYS environment and Fishshell               |          |
| [ ]       | P2       | #15027 | Conflicting installation guidance for Windows                    |          |
| [ ]       | P2       | #10070 | canvas:a2ui:bundle script not Windows compatible                 |          |
| [x]       | P3       | #26160 | Windows support for obsidian skill _(stale)_                     |          |
| [ ]       | P3       | #26110 | macOS-in-Docker for full experience on Linux/Windows x86         |          |
| [ ]       | P3       | #75    | Linux/Windows Clawdbot Apps                                      |          |

---

## 4. Windows Platform — PRs

| Resolved? | Priority | #      | Title                                                                                | Assignee            |
| --------- | -------- | ------ | ------------------------------------------------------------------------------------ | ------------------- |
| [x]       | P1       | #54588 | feat(windows): add native WinUI 3 companion app [AI-assisted]                        |                     |
| [ ]       | P1       | #54431 | Feat/Windows Search Index file search                                                |                     |
| [ ]       | P1       | #54205 | Fix: read tool treats Windows absolute paths as relative to workspace (Issue #54039) |                     |
| [ ]       | P1       | #54120 | fix(windows): hide console window during gateway restart                             |                     |
| [ ]       | P1       | #54066 | fix(tools): detect Windows drive-letter paths as absolute on POSIX hosts (#54039)    |                     |
| [x]       | P1       | #62286 | fix(channels): keep bundled dist loads off native Jiti on Windows                    | @chen-zhang-cs-code |
| [x]       | P1       | #60480 | fix: implement Windows stale gateway process cleanup before restart                  | @arifahmedjoy       |
| [x]       | P1       | #60692 | refactor(acpx): split Windows command parsing                                        | @steipete           |
| [x]       | P1       | #60689 | fix(acpx): preserve Windows Claude CLI paths                                         | @steipete           |
| [ ]       | P1       | #53965 | fix: atomic file writes on Windows-mounted Docker volumes                            |                     |
| [ ]       | P1       | #53664 | Improve Windows source-dev support and make scripts cross-platform                   |                     |
| [ ]       | P1       | #53121 | Add Windows service support to gateway status                                        |                     |
| [ ]       | P1       | #52487 | fix(windows): prevent restart race from duplicate schtasks /Run                      |                     |
| [ ]       | P1       | #52485 | fix(windows): detect stale gateway PIDs via netstat                                  |                     |
| [ ]       | P1       | #52291 | fix(ui): make ui:build work on Windows                                               |                     |
| [ ]       | P1       | #52200 | fix(skills): normalize backslashes in compacted skill paths on Windows               |                     |
| [ ]       | P1       | #51559 | fix(process): add windowsHide to spawn in runCommandWithTimeout                      |                     |
| [ ]       | P1       | #51547 | fix(exec): default to GBK encoding on Windows (#50519)                               |                     |
| [ ]       | P1       | #51486 | fix(daemon): query Windows task runtime directly                                     |                     |
| [ ]       | P1       | #50885 | process: fix Windows runExec garbled CJK output [AI-assisted]                        |                     |
| [ ]       | P1       | #50586 | fix(exec): use gbk encoding for Windows cmd.exe wrapper [AI-assisted]                |                     |
| [ ]       | P1       | #50136 | fix(windows): stabilize gateway restart and avoid false stale cleanup [AI-assisted]  |                     |
| [ ]       | P1       | #50116 | fix: handle Windows-style session paths when running on POSIX                        |                     |
| [ ]       | P1       | #48887 | Fix/docs format check windows clean                                                  |                     |
| [ ]       | P1       | #48613 | Fix/compatible with native windows                                                   |                     |
| [x]       | P1       | #48557 | test: normalize Windows plugin path assertions                                       |                     |
| [x]       | P1       | #48544 | fix(tests): stabilize Windows CI cases                                               |                     |
| [ ]       | P1       | #48320 | fix(windows): add windowsHide to all Windows spawn resolution paths                  |                     |
| [ ]       | P1       | #48130 | fix: correct Windows Chrome executable path extraction regex                         |                     |
| [ ]       | P1       | #47751 | fix: wrap bunx with cmd shim on Windows                                              |                     |
| [ ]       | P1       | #47734 | fix: handle Windows schtasks "Last Result" key variant                               |                     |
| [ ]       | P1       | #46992 | Fix: Windows terminal encoding set to UTF-8                                          |                     |
| [ ]       | P1       | #45870 | fix: align windows path tests with runtime behavior                                  |                     |
| [ ]       | P1       | #45860 | fix(build): prefer usable POSIX shells for Windows bundling                          |                     |
| [ ]       | P1       | #45380 | Make env-prefixed npm scripts work on Windows                                        |                     |
| [ ]       | P2       | #53788 | docs(windows): companion app copy and GitHub auth notes                              |                     |
| [ ]       | P2       | #44234 | docs(windows): note Git Bash requirement for A2UI builds                             |                     |
| [ ]       | P2       | #44228 | fix(reply): normalize Windows media paths for dedupe                                 |                     |
| [ ]       | P2       | #44215 | fix(path): add Windows PATH bootstrap dirs                                           |                     |
| [ ]       | P2       | #44211 | fix(build): use Git Bash wrapper for A2UI bundling on Windows                        |                     |
| [ ]       | P2       | #43624 | fix(gateway): fall back to PowerShell when wmic unavailable on Windows               |                     |
| [ ]       | P2       | #43611 | decode Windows console output (GBK/CP936)                                            |                     |
| [ ]       | P2       | #42174 | fix: false error of Windows path when binding host path to sandbox                   |                     |
| [ ]       | P2       | #39644 | fix(windows): PowerShell completion install and time-format detection                |                     |
| [ ]       | P2       | #38932 | docs(gateway): add Windows no-Docker hardening fallback guide                        |                     |
| [ ]       | P2       | #38846 | security(windows): enhance command argument validation                               |                     |
| [ ]       | P2       | #37592 | fix(windows): handle spaces in Node.js path for plugin install                       |                     |
| [x]       | P2       | #32602 | Tests: skip ios-team-id on Windows                                                   |                     |
| [x]       | P1       | #59466 | [codex] Hide Windows exec console windows                                            |                     |
| [x]       | P1       | #59843 | fix: detect PID recycling in gateway lock on Windows/macOS + startup progress        |                     |
| [ ]       | P2       | #59705 | [codex] improve parallels windows smoke logging _(draft)_                            |                     |
| [x]       | P2       | #59647 | ci: raise Windows checks timeout to 90 minutes                                       |                     |

---

## 5. WSL (Windows Subsystem for Linux) — Issues

| Resolved? | Priority | #      | Title                                                                                      | Labels             | Assignee |
| --------- | -------- | ------ | ------------------------------------------------------------------------------------------ | ------------------ | -------- |
| [x]       | P0       | #47590 | Gateway binds on WSL2 but never responds to probe/health/TUI                               |                    |          |
| [x]       | P1       | #54498 | [Bug]: OpenClaw WSL2 Ollama connection failure (resolved by #55435)                        |                    |          |
| [ ]       | P1       | #53877 | Gateway self-probe fails under WSL2 mirrored networking (networkingMode=mirrored)          |                    |          |
| [ ]       | P1       | #52180 | [Bug]: Podman Windows WSL permission denied                                                |                    |          |
| [x]       | P1       | #44180 | WSL2: os.networkInterfaces() can throw and crash gateway                                   |                    |          |
| [ ]       | P1       | #44051 | [skills] Skipping skill path error on WSL Environment                                      | `bug` `regression` |          |
| [ ]       | P1       | #43891 | Build failure on Windows: canvas:a2ui:bundle triggers WSL instead of Git Bash              | `bug` `bug:crash`  |          |
| [ ]       | P1       | #42557 | exec host=node: path validation breaks cross-platform (WSL->Windows)                       |                    |          |
| [ ]       | P1       | #31980 | [WSL2 Mirrored Mode] Gateway fails to start — "another gateway instance" error             | `bug` `regression` |
| [ ]       | P1       | #59833 | Telegram polling stalls on startup in 2026.4.1 (WSL2)                                      | `bug` `regression` |
| [x]       | P1       | #59065 | LINE provider breaks on WSL2 with Unable to resolve runtime module ./runtime-line.contract | `bug`              |          |
| [ ]       | P2       | #41553 | Surface diagnostics for Control UI auth in WSL2 + Windows setups                           | `enhancement`      |          |
| [ ]       | P2       | #34239 | windows 11 wsl ubtu                                                                        | `enhancement`      |          |
| [ ]       | P2       | #20386 | Node host approval socket not responding on Windows/WSL                                    |                    |          |
| [x]       | P2       | #16649 | WSL2: Control Windows browsers (Edge, Chrome) from OpenClaw                                |                    |          |
| [x]       | P2       | #7122  | DX Improvements for Windows/WSL2 Onboarding                                                | `enhancement`      |          |
| [ ]       | P2       | #7057  | Flaky tests on Windows/WSL: timeouts and ENOENT                                            | `enhancement`      |          |

### WSL — PRs

| Resolved? | Priority | #      | Title                                                                                                               | Assignee |
| --------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------- | -------- |
| [x]       | P1       | #55435 | fix(plugins): WSL2 Ollama diagnostics — disable autoSelectFamily + unwrap error.cause                               |          |
| [ ]       | P1       | #53950 | docs: add hypervisorlaunchtype toggle recovery to WSL2+Windows remote CDP guide                                     |          |
| [x]       | P1       | #52215 | fix(podman): relax image tar directory permissions for WSL                                                          |          |
| [x]       | P1       | #52202 | fix[Bug]: [skills] Skipping skill path error triggered on officially installed skills via clawhub (WSL Environment) |          |
| [x]       | P1       | #52078 | fix(cli): add WSL2 detection for gateway handshake timeout (#51879)                                                 |          |
| [ ]       | P1       | #46698 | fix(auth): fix GitHub device flow polling and add --wait flag for WSL                                               |          |
| [x]       | P1       | #44419 | fix(gateway): guard interface discovery failures on WSL                                                             |          |
| [ ]       | P1       | #44129 | fix(skills): exempt managed skills from path escaping checks on WSL                                                 |          |
| [x]       | P1       | #44082 | fix: Skipping skill path error on WSL Environment                                                                   |          |
| [x]       | P2       | #42857 | Tests: clear inherited WSL env in wsl detection test                                                                |          |
| [ ]       | P2       | #33321 | fix(build): add WSL detection to bundle-a2ui.sh                                                                     |          |
| [ ]       | P2       | #31840 | Build: harden A2UI bundle for Windows+WSL shell path                                                                |          |

---

## 6. Azure (Provider / Infrastructure) — Issues

| Resolved? | Priority | #      | Title                                                                                                                     | Labels             | Assignee |
| --------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------- |
| [x]       | P0       | #48939 | tui/agent not working when Azure OpenAI endpoint is onboarded                                                             | `bug`              |          |
| [ ]       | P1       | #54645 | 400 error after update: 'reasoning' item provided without required following item (azure-openai-responses, gpt-5.3-codex) |                    |          |
| [ ]       | P1       | #60546 | [Bug]: microsoft-foundry provider selects Claude deployments but routes them through OpenAI Foundry endpoints             |                    |          |
| [ ]       | P1       | #53506 | [Bug]: API Protocol Error 400 with Azure Reasoning Models in v2026.3.23 (works in v2026.3.18)                             |                    |          |
| [ ]       | P1       | #52444 | Azure OpenAI (cognitiveservices) Chat Completions returns 404 with openai-completions API                                 |                    |          |
| [ ]       | P1       | #51869 | [Bug]: onboard-custom hardcodes input: ["text"] for non-Azure custom providers, silently disabling image/vision support   |                    |          |
| [ ]       | P1       | #51735 | Config schema missing 'azure-openai-responses' in models.providers.\*.api enum                                            |                    |          |
| [ ]       | P1       | #48107 | OpenAI SDK baseUrl query params silently dropped, breaking Azure OpenAI Responses API                                     |                    |          |
| [ ]       | P1       | #46971 | Azure OpenAI missing api-version query parameter causes 404 errors                                                        |                    |          |
| [ ]       | P1       | #46676 | Azure OpenAI: api-version sent as header instead of query param causing 404                                               |                    |          |
| [ ]       | P1       | #38784 | Azure OpenAI models report 0 context tokens                                                                               |                    |          |
| [ ]       | P1       | #37123 | Azure OpenAI provider not appearing during onboarding                                                                     | `bug` `regression` |          |
| [ ]       | P1       | #34241 | Intermittent no-tool execution after switching to azure-openai-responses                                                  | `bug` `regression` |          |
| [ ]       | P1       | #32179 | Azure Foundry Anthropic: SSE stream events concatenated without delimiter                                                 |                    |          |
| [x]       | P1       | #28641 | Custom provider not accepting Azure Cognitive Service URL                                                                 | `bug`              |          |
| [x]       | P2       | #48899 | Fix dedicated ACA worker: missing SystemAssigned identity                                                                 |                    |          |
| [x]       | P2       | #48116 | Phase 10: Fix dedicated ACA provisioning — env vars, retry logic                                                          |                    |          |
| [ ]       | P2       | #54820 | False positive: 'azure-bing-grounding' flagged as suspicious on ClawHub                                                   |                    |          |
| [x]       | P2       | #7249  | Support Claude Models via Azure service                                                                                   | `enhancement`      |          |
| [x]       | P3       | #25058 | azure-responses sends rs\__ reference when supportsStore=false _(stale)\*                                                 |                    |          |

### Azure — PRs

| Resolved? | Priority | #      | Title                                                                             | Assignee |
| --------- | -------- | ------ | --------------------------------------------------------------------------------- | -------- |
| [ ]       | P1       | #52555 | docs: add Azure Container Apps install guide with managed identity _(draft)_      |          |
| [ ]       | P1       | #52272 | Azure Blob Storage data access extension                                          |          |
| [ ]       | P1       | #52263 | Add Jitsi bridge with downstream-configurable identity and Azure model updates    |          |
| [x]       | P1       | #52053 | fix(config): add azure-openai-responses to MODEL_APIS enum                        |          |
| [x]       | P1       | #51973 | feat: Add Microsoft Foundry provider with Entra ID authentication                 |          |
| [ ]       | P1       | #51965 | Onboarding: heuristic vision inputs for non-Azure custom models (#51869)          |          |
| [ ]       | P1       | #51893 | fix(onboard): infer vision input for non-Azure custom models                      |          |
| [ ]       | P1       | #51776 | feat(tts): add Azure Speech TTS provider                                          |          |
| [ ]       | P1       | #51321 | feat(tts): add Azure Speech TTS provider                                          |          |
| [x]       | P1       | #50851 | chore(provider): use pi-ai's azure-openai-responses for azure openai endpoints    |          |
| [x]       | P1       | #50740 | fix(onboard): restore openai-responses API for all Azure URLs                     |          |
| [ ]       | P1       | #48267 | Azure models support (rebased)                                                    |          |
| [x]       | P1       | #47898 | docs: add Azure VM deployment guide with ARM templates                            |          |
| [ ]       | P1       | #47285 | feat(memory-lancedb): native Azure OpenAI support                                 |          |
| [x]       | P1       | #47181 | feat: add Azure Claude (AI Foundry) onboarding path                               |          |
| [x]       | P1       | #46760 | fix(azure): ensure api-version is sent as query param not header                  |          |
| [ ]       | P1       | #39540 | Add support for Azure models (GPT-5.4 and more)                                   |          |
| [ ]       | P1       | #37717 | feat: add Azure api-version support for OpenAI-compatible chat                    |          |
| [x]       | P2       | #25166 | Docs: add Azure OpenAI provider guide                                             |          |
| [x]       | P3       | #25758 | Feat/azure ai provider _(stale)_                                                  |          |
| [x]       | P3       | #17970 | Copilot/refactor serverless azure function _(stale)_                              |          |
| [x]       | P3       | #12059 | feat(agents): Add Azure AI Foundry credential support _(stale)_                   |          |
| [x]       | P1       | #59652 | fix(microsoft-tts): default to Opus output format for voice message compatibility |          |

---

## 7. Microsoft 365 / SharePoint — Issues

| Resolved? | Priority | #      | Title                                                            | Labels        | Assignee |
| --------- | -------- | ------ | ---------------------------------------------------------------- | ------------- | -------- |
| [x]       | P2       | #30299 | Microsoft SharePoint and Openclaw                                | `enhancement` |          |
| [x]       | P2       | #30023 | Native Microsoft 365 integration (like gog for Google Workspace) | `enhancement` |          |
| [ ]       | P3       | #40439 | ClawHub skill review pending: sharepoint-by-altf1be              |               |          |

---

## Appendix: P0 Blockers (Start Here)

| Resolved? | #      | Title                                                          |
| --------- | ------ | -------------------------------------------------------------- |
| [x]       | #54852 | msteams pathToRegexp crash on 2026.3.24                        |
| [x]       | #54755 | v2026.3.24: Express 5 route regression + duplicate plugin loop |
| [x]       | #54703 | Teams Broken After 2026.3.24 updates                           |
| [x]       | #53953 | msteams plugin crash — module singleton mismatch               |
| [x]       | #54801 | Gateway can't start in Windows                                 |
| [x]       | #54880 | PR: fix Teams HttpPlugin /api\* route pattern                  |
| [x]       | #54866 | PR: bump @microsoft/teams.apps to 2.0.6                        |
| [ ]       | #48659 | PR: MSTeams harden integration (XL)                            |
| [x]       | #44857 | Broken bundled msteams extension                               |
| [x]       | #43648 | MS Teams inline images crash                                   |
| [x]       | #48832 | Windows CHANNEL_IDS not iterable                               |
| [x]       | #48756 | Windows gateway restart/stop fail                              |
| [x]       | #48736 | Windows WebSocket 80% failure                                  |
| [x]       | #47590 | WSL2 gateway unresponsive                                      |
| [x]       | #48939 | Azure OpenAI endpoint broken                                   |

## Appendix: Stale Items (Consider Closing)

| Resolved? | #      | Title                                             |
| --------- | ------ | ------------------------------------------------- |
| [x]       | #28014 | msteams inline image downloads (1:1 chats)        |
| [x]       | #26599 | msteams false media:document detection            |
| [x]       | #24797 | msteams image attachments (3 bugs)                |
| [x]       | #17783 | Teams setup on Raspberry Pi                       |
| [x]       | #15622 | Teams deps wiped on npm update                    |
| [x]       | #14436 | JWT blocks Bot Framework webhooks                 |
| [x]       | #19908 | WhatsApp migration to Teams Graph                 |
| [x]       | #25856 | Windows cmd.exe flash from ARP                    |
| [x]       | #25376 | Exec allowlist unsupported platform               |
| [x]       | #24441 | Windows reliability: lock + cron + instance guard |
| [x]       | #23612 | Windows installation failure                      |
| [x]       | #23509 | SIGUSR1 orphaned process                          |
| [x]       | #23109 | Silent media failure on Windows                   |
| [x]       | #21990 | Exec no stdout/stderr on Windows                  |
| [x]       | #21678 | Missing windowsHide:true                          |
| [x]       | #16323 | Windows command injection security                |
| [x]       | #26160 | Obsidian skill Windows support                    |
| [x]       | #25058 | Azure rs\_\* reference leak                       |
| [x]       | #27765 | PR: msteams replyStyle DM override                |
| [x]       | #26274 | PR: msteams image auth fix                        |
| [x]       | #25511 | PR: msteams suppress reasoning text               |
| [x]       | #8964  | PR: msteams graph-upload tests                    |
| [x]       | #25758 | PR: Azure AI provider                             |
| [x]       | #17970 | PR: Azure function refactor                       |
| [x]       | #12059 | PR: Azure AI Foundry credentials                  |

---
