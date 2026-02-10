---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Deep troubleshooting runbook for gateway, channels, automation, nodes, and browser"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - The troubleshooting hub pointed you here for deeper diagnosis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need stable symptom based runbook sections with exact commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Troubleshooting"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Gateway troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This page is the deep runbook.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Start at [/help/troubleshooting](/help/troubleshooting) if you want the fast triage flow first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Command ladder（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run these first, in this order:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Expected healthy signals:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway status` shows `Runtime: running` and `RPC probe: ok`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw doctor` reports no blocking config/service issues.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw channels status --probe` shows connected/ready channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## No replies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If channels are up but nothing answers, check routing and policy before reconnecting anything.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing list <channel>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Look for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pairing pending for DM senders.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group mention gating (`requireMention`, `mentionPatterns`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel/group allowlist mismatches.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `drop guild message (mention required` → group message ignored until mention.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pairing request` → sender needs approval.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `blocked` / `allowlist` → sender/channel was filtered by policy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/channels/troubleshooting](/channels/troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/channels/pairing](/channels/pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/channels/groups](/channels/groups)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Dashboard control ui connectivity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When dashboard/control UI will not connect, validate URL, auth mode, and secure context assumptions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Look for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Correct probe URL and dashboard URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth mode/token mismatch between client and gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- HTTP usage where device identity is required.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `device identity required` → non-secure context or missing device auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `unauthorized` / reconnect loop → token/password mismatch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway connect failed:` → wrong host/port/url target.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/web/control-ui](/web/control-ui)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/gateway/authentication](/gateway/authentication)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/gateway/remote](/gateway/remote)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway service not running（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use this when service is installed but process does not stay up.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status --deep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Look for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Runtime: stopped` with exit hints.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Service config mismatch (`Config (cli)` vs `Config (service)`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Port/listener conflicts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Gateway start blocked: set gateway.mode=local` → local gateway mode is not enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `refusing to bind gateway ... without auth` → non-loopback bind without token/password.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `another gateway instance is already listening` / `EADDRINUSE` → port conflict.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/gateway/background-process](/gateway/background-process)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/gateway/configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/gateway/doctor](/gateway/doctor)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Channel connected messages not flowing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If channel state is connected but message flow is dead, focus on policy, permissions, and channel specific delivery rules.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing list <channel>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status --deep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Look for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- DM policy (`pairing`, `allowlist`, `open`, `disabled`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Group allowlist and mention requirements.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Missing channel API permissions/scopes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `mention required` → message ignored by group mention policy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pairing` / pending approval traces → sender is not approved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → channel auth/permissions issue.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/channels/troubleshooting](/channels/troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/channels/whatsapp](/channels/whatsapp)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/channels/telegram](/channels/telegram)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/channels/discord](/channels/discord)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cron and heartbeat delivery（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If cron or heartbeat did not run or did not deliver, verify scheduler state first, then delivery target.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron runs --id <jobId> --limit 20（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw system heartbeat last（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Look for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron enabled and next wake present.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Job run history status (`ok`, `skipped`, `error`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat skip reasons (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron: scheduler disabled; jobs will not run automatically` → cron disabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron: timer tick failed` → scheduler tick failed; check file/log/runtime errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `heartbeat skipped` with `reason=quiet-hours` → outside active hours window.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `heartbeat: unknown accountId` → invalid account id for heartbeat delivery target.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/automation/troubleshooting](/automation/troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/automation/cron-jobs](/automation/cron-jobs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/gateway/heartbeat](/gateway/heartbeat)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Node paired tool fails（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a node is paired but tools fail, isolate foreground, permission, and approval state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes describe --node <idOrNameOrIp>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals get --node <idOrNameOrIp>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Look for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node online with expected capabilities.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OS permission grants for camera/mic/location/screen.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec approvals and allowlist state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `NODE_BACKGROUND_UNAVAILABLE` → node app must be in foreground.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → missing OS permission.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SYSTEM_RUN_DENIED: approval required` → exec approval pending.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SYSTEM_RUN_DENIED: allowlist miss` → command blocked by allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/nodes/troubleshooting](/nodes/troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/nodes/index](/nodes/index)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/tools/exec-approvals](/tools/exec-approvals)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Browser tool fails（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use this when browser tool actions fail even though the gateway itself is healthy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser start --browser-profile openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw browser profiles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Look for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Valid browser executable path.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CDP profile reachability.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Extension relay tab attachment for `profile="chrome"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Failed to start Chrome CDP on port` → browser process failed to launch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser.executablePath not found` → configured path is invalid.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Chrome extension relay is running, but no tab is connected` → extension relay not attached.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Browser attachOnly is enabled ... not reachable` → attach-only profile has no reachable target.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/tools/chrome-extension](/tools/chrome-extension)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/tools/browser](/tools/browser)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## If you upgraded and something suddenly broke（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Most post-upgrade breakage is config drift or stricter defaults now being enforced.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Auth and URL override behavior changed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get gateway.mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get gateway.remote.url（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get gateway.auth.mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
What to check:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `gateway.mode=remote`, CLI calls may be targeting remote while your local service is fine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Explicit `--url` calls do not fall back to stored credentials.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway connect failed:` → wrong URL target.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `unauthorized` → endpoint reachable but wrong auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Bind and auth guardrails are stricter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get gateway.bind（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get gateway.auth.token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
What to check:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Non-loopback binds (`lan`, `tailnet`, `custom`) need auth configured.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Old keys like `gateway.token` do not replace `gateway.auth.token`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `refusing to bind gateway ... without auth` → bind+auth mismatch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `RPC probe: failed` while runtime is running → gateway alive but inaccessible with current auth/url.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3) Pairing and device identity state changed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw devices list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw pairing list <channel>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
What to check:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pending device approvals for dashboard/nodes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pending DM pairing approvals after policy or identity changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `device identity required` → device auth not satisfied.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pairing required` → sender/device must be approved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the service config and runtime still disagree after checks, reinstall service metadata from the same profile/state directory:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway install --force（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/gateway/pairing](/gateway/pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/gateway/authentication](/gateway/authentication)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/gateway/background-process](/gateway/background-process)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
