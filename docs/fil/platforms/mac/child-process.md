---
summary: "Lifecycle ng Gateway sa macOS (launchd)"
read_when:
  - Pag-iintegrate ng mac app sa lifecycle ng Gateway
title: "Lifecycle ng Gateway"
x-i18n:
  source_path: platforms/mac/child-process.md
  source_hash: 9b910f574b723bc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:40Z
---

# Lifecycle ng Gateway sa macOS

Ang macOS app ay **pinamamahalaan ang Gateway sa pamamagitan ng launchd** bilang default at hindi nito ini-spawn ang Gateway bilang child process. Una nitong sinusubukang kumabit sa isang Gateway na kasalukuyang tumatakbo sa naka-configure na port; kung walang maabot, ina-enable nito ang launchd service sa pamamagitan ng external na `openclaw` CLI (walang embedded runtime). Nagbibigay ito ng maaasahang auto‑start sa login at restart kapag nagka-crash.

Ang child‑process mode (Gateway na direktang ini-spawn ng app) ay **hindi ginagamit** sa kasalukuyan. Kung kailangan mo ng mas mahigpit na coupling sa UI, patakbuhin ang Gateway nang manu-mano sa isang terminal.

## Default na behavior (launchd)

- Ini-install ng app ang isang per‑user LaunchAgent na may label na `bot.molt.gateway`
  (o `bot.molt.<profile>` kapag gumagamit ng `--profile`/`OPENCLAW_PROFILE`; sinusuportahan ang legacy na `com.openclaw.*`).
- Kapag naka-enable ang Local mode, tinitiyak ng app na naka-load ang LaunchAgent at
  sinisimulan ang Gateway kung kinakailangan.
- Ang mga log ay isinusulat sa launchd gateway log path (makikita sa Debug Settings).

Mga karaniwang command:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Palitan ang label ng `bot.molt.<profile>` kapag nagpapatakbo ng named profile.

## Unsigned dev builds

Ang `scripts/restart-mac.sh --no-sign` ay para sa mabilis na local builds kapag wala kang
signing keys. Para maiwasan na ituro ng launchd ang isang unsigned relay binary, ito ay:

- Nagsusulat ng `~/.openclaw/disable-launchagent`.

Ang mga signed run ng `scripts/restart-mac.sh` ay nililinis ang override na ito kung naroroon ang marker. Para i-reset nang manu-mano:

```bash
rm ~/.openclaw/disable-launchagent
```

## Attach-only mode

Para pilitin ang macOS app na **huwag kailanman mag-install o mag-manage ng launchd**, ilunsad ito gamit ang
`--attach-only` (o `--no-launchd`). Itinatakda nito ang `~/.openclaw/disable-launchagent`,
kaya ang app ay kumakabit lamang sa isang Gateway na kasalukuyang tumatakbo. Maaari mong i-toggle ang parehong behavior sa Debug Settings.

## Remote mode

Hindi kailanman nagsisimula ang Remote mode ng lokal na Gateway. Gumagamit ang app ng SSH tunnel papunta sa remote host at kumokonekta sa ibabaw ng tunnel na iyon.

## Bakit mas pinipili namin ang launchd

- Auto‑start sa login.
- Built‑in na restart/KeepAlive semantics.
- Predictable na mga log at supervision.

Kung kakailanganin muli ang isang tunay na child‑process mode, dapat itong idokumento bilang isang hiwalay at malinaw na dev‑only mode.
