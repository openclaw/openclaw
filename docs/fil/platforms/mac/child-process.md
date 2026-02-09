---
summary: "Lifecycle ng Gateway sa macOS (launchd)"
read_when:
  - Pag-iintegrate ng mac app sa lifecycle ng Gateway
title: "Lifecycle ng Gateway"
---

# Lifecycle ng Gateway sa macOS

Bilang default, **pinamamahalaan ng macOS app ang Gateway sa pamamagitan ng launchd** at hindi nito sini-spawn ang Gateway bilang child process. Una nitong sinusubukang kumonekta sa isang tumatakbong Gateway sa naka-configure na port; kung wala itong maabot, ina-enable nito ang launchd service sa pamamagitan ng external `openclaw` CLI (walang embedded runtime). Nagbibigay ito sa iyo ng maaasahang auto‑start sa pag-login at restart kapag nagka-crash.

Ang child‑process mode (Gateway na direktang sini-spawn ng app) ay **hindi ginagamit** sa ngayon.
Kung kailangan mo ng mas mahigpit na integrasyon sa UI, patakbuhin ang Gateway nang manu-mano sa isang terminal.

## Default na behavior (launchd)

- Nag-i-install ang app ng isang per‑user LaunchAgent na may label na `bot.molt.gateway`
  (o `bot.molt.<profile>`` kapag gumagamit ng `--profile`/`OPENCLAW_PROFILE`; sinusuportahan ang legacy `com.openclaw.\*\`).
- Kapag naka-enable ang Local mode, tinitiyak ng app na naka-load ang LaunchAgent at
  sinisimulan ang Gateway kung kinakailangan.
- Ang mga log ay isinusulat sa launchd gateway log path (makikita sa Debug Settings).

Mga karaniwang command:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Palitan ang label ng \`bot.molt.<profile>\`\` kapag nagpapatakbo ng isang pinangalanang profile.

## Unsigned dev builds

Ang `scripts/restart-mac.sh --no-sign` ay para sa mabilis na local build kapag wala kang signing keys. Upang maiwasan ang launchd na tumuro sa isang unsigned na relay binary, ito ay:

- Nagsusulat ng `~/.openclaw/disable-launchagent`.

Nililinis ng mga signed na run ng `scripts/restart-mac.sh` ang override na ito kung naroon ang marker. Upang i-reset nang manu-mano:

```bash
rm ~/.openclaw/disable-launchagent
```

## Attach-only mode

Upang pilitin ang macOS app na **huwag kailanman mag-install o mamahala ng launchd**, ilunsad ito gamit ang
`--attach-only` (o `--no-launchd`). Itinatakda nito ang `~/.openclaw/disable-launchagent`,
kaya ang app ay kumakabit lamang sa isang tumatakbong Gateway na. Maaari mong i-toggle ang parehong
pag-uugali sa Debug Settings.

## Remote mode

Hindi kailanman nagsisimula ang remote mode ng isang lokal na Gateway. Gumagamit ang app ng isang SSH tunnel papunta sa
remote host at kumokonekta sa pamamagitan ng tunnel na iyon.

## Bakit mas pinipili namin ang launchd

- Auto‑start sa login.
- Built‑in na restart/KeepAlive semantics.
- Predictable na mga log at supervision.

Kung kakailanganin muli ang isang tunay na child‑process mode, dapat itong idokumento bilang isang hiwalay at malinaw na dev‑only mode.
