---
summary: "Malalim na troubleshooting runbook para sa gateway, mga channel, automation, mga node, at browser"
read_when:
  - Itinuro ka rito ng troubleshooting hub para sa mas malalim na diagnosis
  - Kailangan mo ng matatag na mga seksyon ng runbook na batay sa sintomas na may eksaktong mga command
title: "Pag-troubleshoot"
---

# Pag-troubleshoot ng Gateway

Ito ang malalim na runbook.
Magsimula sa [/help/troubleshooting](/help/troubleshooting) kung gusto mo muna ang mabilis na triage flow.

## Hagdan ng command

Patakbuhin muna ang mga ito, sa ganitong pagkakasunod-sunod:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Inaasahang malusog na mga senyales:

- `openclaw gateway status` ay nagpapakita ng `Runtime: running` at `RPC probe: ok`.
- `openclaw doctor` ay nag-uulat na walang humaharang na isyu sa config/serbisyo.
- `openclaw channels status --probe` ay nagpapakita ng mga channel na connected/ready.

## Walang mga sagot

Kung naka-up ang mga channel pero walang sumasagot, suriin muna ang routing at policy bago mag-reconnect ng anuman.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

Hanapin ang:

- Pending ang pairing para sa mga DM sender.
- Group mention gating (`requireMention`, `mentionPatterns`).
- Mga hindi tugmang allowlist ng channel/group.

Karaniwang mga signature:

- `drop guild message (mention required` → binalewala ang mensahe sa group hanggang ma-mention.
- `pairing request` → kailangan ng approval ang sender.
- `blocked` / `allowlist` → na-filter ng policy ang sender/channel.

Kaugnay:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## Pagkakakonekta ng Dashboard control UI

Kapag hindi kumokonekta ang dashboard/control UI, i-validate ang URL, auth mode, at mga assumption sa secure context.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

Hanapin ang:

- Tamang probe URL at dashboard URL.
- Hindi tugmang auth mode/token sa pagitan ng client at gateway.
- Paggamit ng HTTP kung saan kailangan ang device identity.

Karaniwang mga signature:

- `device identity required` → non-secure context o nawawalang device auth.
- `unauthorized` / reconnect loop → hindi tugmang token/password.
- `gateway connect failed:` → maling host/port/url target.

Kaugnay:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## Hindi tumatakbo ang serbisyo ng Gateway

Gamitin ito kapag naka-install ang serbisyo pero hindi nananatiling tumatakbo ang proseso.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

Hanapin ang:

- `Runtime: stopped` na may mga hint sa pag-exit.
- Hindi tugmang service config (`Config (cli)` vs `Config (service)`).
- Mga conflict sa port/listener.

Karaniwang mga signature:

- `Gateway start blocked: set gateway.mode=local` → hindi naka-enable ang local gateway mode.
- `refusing to bind gateway ... without auth` → non-loopback bind na walang token/password.
- `another gateway instance is already listening` / `EADDRINUSE` → conflict sa port.

Kaugnay:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## Connected ang channel pero hindi dumadaloy ang mga mensahe

Kung connected ang estado ng channel pero patay ang daloy ng mensahe, tumuon sa policy, mga pahintulot, at mga panuntunan sa delivery na partikular sa channel.

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Hanapin ang:

- DM policy (`pairing`, `allowlist`, `open`, `disabled`).
- Group allowlist at mga requirement sa mention.
- Nawawalang channel API permissions/scopes.

Karaniwang mga signature:

- `mention required` → binalewala ang mensahe dahil sa group mention policy.
- `pairing` / mga trace ng pending approval → hindi approved ang sender.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → isyu sa channel auth/permissions.

Kaugnay:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Paghahatid ng cron at heartbeat

Kung hindi tumakbo ang cron o heartbeat o hindi ito nakapag-deliver, i-verify muna ang estado ng scheduler, saka ang delivery target.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

Hanapin ang:

- Naka-enable ang cron at may susunod na wake.
- Status ng job run history (`ok`, `skipped`, `error`).
- Mga dahilan ng pag-skip ng heartbeat (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

Karaniwang mga signature:

- `cron: scheduler disabled; jobs will not run automatically` → naka-disable ang cron.
- `cron: timer tick failed` → nabigo ang scheduler tick; suriin ang file/log/runtime errors.
- `heartbeat skipped` kasama ang `reason=quiet-hours` → nasa labas ng window ng active hours.
- `heartbeat: unknown accountId` → invalid na account id para sa heartbeat delivery target.

Kaugnay:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## Nabigo ang tool ng naka-pair na node

Kung naka-pair ang node pero nabibigo ang mga tool, ihiwalay ang estado ng foreground, mga pahintulot, at approval.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Hanapin ang:

- Online ang node na may inaasahang mga kakayahan.
- Mga grant ng OS permission para sa camera/mic/location/screen.
- Mga exec approval at estado ng allowlist.

Karaniwang mga signature:

- `NODE_BACKGROUND_UNAVAILABLE` → kailangang nasa foreground ang node app.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → nawawalang OS permission.
- `SYSTEM_RUN_DENIED: approval required` → pending ang exec approval.
- `SYSTEM_RUN_DENIED: allowlist miss` → na-block ng allowlist ang command.

Kaugnay:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## Nabigo ang browser tool

Gamitin ito kapag nabibigo ang mga aksyon ng browser tool kahit malusog ang mismong gateway.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Hanapin ang:

- Valid na browser executable path.
- Reachability ng CDP profile.
- Attachment ng extension relay tab para sa `profile="chrome"`.

Karaniwang mga signature:

- `Failed to start Chrome CDP on port` → nabigong mag-launch ang browser process.
- `browser.executablePath not found` → invalid ang naka-configure na path.
- `Chrome extension relay is running, but no tab is connected` → hindi naka-attach ang extension relay.
- `Browser attachOnly is enabled ... not reachable` → ang attach-only profile ay walang maaabot na target.

Kaugnay:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## Kung nag-upgrade ka at may biglang nasira

Karamihan ng pagkasira pagkatapos ng upgrade ay dahil sa config drift o mas mahigpit na mga default na ipinatutupad na ngayon.

### 1. Nagbago ang behavior ng auth at URL override

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

Ano ang susuriin:

- Kung `gateway.mode=remote`, maaaring tumatarget sa remote ang mga tawag ng CLI habang maayos naman ang lokal mong serbisyo.
- Ang mga tahasang `--url` na tawag ay hindi bumabalik sa nakaimbak na credentials.

Karaniwang mga signature:

- `gateway connect failed:` → maling URL target.
- `unauthorized` → reachable ang endpoint pero maling auth.

### 2. Mas mahigpit ang bind at auth guardrails

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

Ano ang susuriin:

- Ang mga non-loopback bind (`lan`, `tailnet`, `custom`) ay nangangailangan ng naka-configure na auth.
- Ang mga lumang key tulad ng `gateway.token` ay hindi pumapalit sa `gateway.auth.token`.

Karaniwang mga signature:

- `refusing to bind gateway ... without auth` → hindi tugma ang bind+auth.
- `RPC probe: failed` habang tumatakbo ang runtime → buhay ang gateway pero hindi naa-access gamit ang kasalukuyang auth/url.

### 3. Nagbago ang estado ng pairing at device identity

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

Ano ang susuriin:

- Mga pending na device approval para sa dashboard/mga node.
- Mga pending na DM pairing approval pagkatapos ng mga pagbabago sa policy o identity.

Karaniwang mga signature:

- `device identity required` → hindi natutugunan ang device auth.
- `pairing required` → kailangang ma-approve ang sender/device.

Kung hindi pa rin magkasundo ang service config at runtime pagkatapos ng mga pagsusuri, i-reinstall ang service metadata mula sa parehong profile/state directory:

```bash
openclaw gateway install --force
openclaw gateway restart
```

Kaugnay:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
