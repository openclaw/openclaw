---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Symptom first troubleshooting hub for OpenClaw"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - OpenClaw is not working and you need the fastest path to a fix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want a triage flow before diving into deep runbooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Troubleshooting"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you only have 2 minutes, use this page as a triage front door.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## First 60 seconds（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run this exact ladder in order:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status --all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Good output in one line:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw status` → shows configured channels and no obvious auth errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw status --all` → full report is present and shareable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway probe` → expected gateway target is reachable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway status` → `Runtime: running` and `RPC probe: ok`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw doctor` → no blocking config/service errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw channels status --probe` → channels report `connected` or `ready`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw logs --follow` → steady activity, no repeating fatal errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Decision tree（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```mermaid（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
flowchart TD（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  A[OpenClaw is not working] --> B{What breaks first}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  B --> C[No replies]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  B --> D[Dashboard or Control UI will not connect]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  B --> E[Gateway will not start or service not running]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  B --> F[Channel connects but messages do not flow]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  B --> G[Cron or heartbeat did not fire or did not deliver]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  B --> H[Node is paired but camera canvas screen exec fails]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  B --> I[Browser tool fails]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  C --> C1[/No replies section/]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  D --> D1[/Control UI section/]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  E --> E1[/Gateway section/]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  F --> F1[/Channel flow section/]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  G --> G1[/Automation section/]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  H --> H1[/Node tools section/]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  I --> I1[/Browser section/]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="No replies">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw pairing list <channel>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Good output looks like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `Runtime: running`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `RPC probe: ok`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Your channel shows connected/ready in `channels status --probe`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Sender appears approved (or DM policy is open/allowlist)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Common log signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `drop guild message (mention required` → mention gating blocked the message in Discord.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `pairing request` → sender is unapproved and waiting for DM pairing approval.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `blocked` / `allowlist` in channel logs → sender, room, or group is filtered.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Deep pages:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/gateway/troubleshooting#no-replies](/gateway/troubleshooting#no-replies)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/channels/troubleshooting](/channels/troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/channels/pairing](/channels/pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Dashboard or Control UI will not connect">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Good output looks like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `Dashboard: http://...` is shown in `openclaw gateway status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `RPC probe: ok`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - No auth loop in logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Common log signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `device identity required` → HTTP/non-secure context cannot complete device auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `unauthorized` / reconnect loop → wrong token/password or auth mode mismatch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `gateway connect failed:` → UI is targeting the wrong URL/port or unreachable gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Deep pages:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/gateway/troubleshooting#dashboard-control-ui-connectivity](/gateway/troubleshooting#dashboard-control-ui-connectivity)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/web/control-ui](/web/control-ui)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/gateway/authentication](/gateway/authentication)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Gateway will not start or service installed but not running">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Good output looks like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `Service: ... (loaded)`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `Runtime: running`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `RPC probe: ok`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Common log signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `Gateway start blocked: set gateway.mode=local` → gateway mode is unset/remote.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `refusing to bind gateway ... without auth` → non-loopback bind without token/password.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `another gateway instance is already listening` or `EADDRINUSE` → port already taken.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Deep pages:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/gateway/troubleshooting#gateway-service-not-running](/gateway/troubleshooting#gateway-service-not-running)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/gateway/background-process](/gateway/background-process)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/gateway/configuration](/gateway/configuration)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Channel connects but messages do not flow">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Good output looks like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Channel transport is connected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Pairing/allowlist checks pass.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Mentions are detected where required.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Common log signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `mention required` → group mention gating blocked processing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `pairing` / `pending` → DM sender is not approved yet.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `not_in_channel`, `missing_scope`, `Forbidden`, `401/403` → channel permission token issue.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Deep pages:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/gateway/troubleshooting#channel-connected-messages-not-flowing](/gateway/troubleshooting#channel-connected-messages-not-flowing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/channels/troubleshooting](/channels/troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Cron or heartbeat did not fire or did not deliver">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw cron status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw cron list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw cron runs --id <jobId> --limit 20（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Good output looks like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `cron.status` shows enabled with a next wake.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `cron runs` shows recent `ok` entries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Heartbeat is enabled and not outside active hours.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Common log signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `cron: scheduler disabled; jobs will not run automatically` → cron is disabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `heartbeat skipped` with `reason=quiet-hours` → outside configured active hours.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `requests-in-flight` → main lane busy; heartbeat wake was deferred.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `unknown accountId` → heartbeat delivery target account does not exist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Deep pages:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/gateway/troubleshooting#cron-and-heartbeat-delivery](/gateway/troubleshooting#cron-and-heartbeat-delivery)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/automation/troubleshooting](/automation/troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/gateway/heartbeat](/gateway/heartbeat)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Node is paired but tool fails camera canvas screen exec">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw nodes status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw nodes describe --node <idOrNameOrIp>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Good output looks like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Node is listed as connected and paired for role `node`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Capability exists for the command you are invoking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Permission state is granted for the tool.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Common log signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `NODE_BACKGROUND_UNAVAILABLE` → bring node app to foreground.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `*_PERMISSION_REQUIRED` → OS permission was denied/missing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `SYSTEM_RUN_DENIED: approval required` → exec approval is pending.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `SYSTEM_RUN_DENIED: allowlist miss` → command not on exec allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Deep pages:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/gateway/troubleshooting#node-paired-tool-fails](/gateway/troubleshooting#node-paired-tool-fails)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/nodes/troubleshooting](/nodes/troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/tools/exec-approvals](/tools/exec-approvals)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  <Accordion title="Browser tool fails">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw browser status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Good output looks like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Browser status shows `running: true` and a chosen browser/profile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `openclaw` profile starts or `chrome` relay has an attached tab.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Common log signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `Failed to start Chrome CDP on port` → local browser launch failed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `browser.executablePath not found` → configured binary path is wrong.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `Chrome extension relay is running, but no tab is connected` → extension not attached.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `Browser attachOnly is enabled ... not reachable` → attach-only profile has no live CDP target.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Deep pages:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/gateway/troubleshooting#browser-tool-fails](/gateway/troubleshooting#browser-tool-fails)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - [/tools/chrome-extension](/tools/chrome-extension)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  </Accordion>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</AccordionGroup>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
