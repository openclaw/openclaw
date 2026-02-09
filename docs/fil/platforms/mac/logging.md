---
summary: "Pagla-log ng OpenClaw: rolling diagnostics file log + unified log privacy flags"
read_when:
  - Pagkuha ng macOS logs o pag-imbestiga ng pagla-log ng pribadong data
  - Pag-debug ng mga isyu sa voice wake/session lifecycle
title: "Pagla-log sa macOS"
---

# Logging (macOS)

## Rolling diagnostics file log (Debug pane)

Ipinapadaan ng OpenClaw ang mga macOS app log sa swift-log (unified logging bilang default) at maaaring magsulat ng lokal, umiikot na file log sa disk kapag kailangan mo ng matibay na capture.

- Verbosity: **Debug pane → Logs → App logging → Verbosity**
- Paganahin: **Debug pane → Logs → App logging → “Write rolling diagnostics log (JSONL)”**
- Lokasyon: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (awtomatikong umiikot; ang mga lumang file ay may suffix na `.1`, `.2`, …)
- I-clear: **Debug pane → Logs → App logging → “Clear”**

Mga tala:

- Ito ay **naka-off bilang default**. I-enable lamang habang aktibong nagde-debug.
- Ituring ang file bilang sensitibo; huwag itong ibahagi nang walang pagsusuri.

## Unified logging private data sa macOS

Ang unified logging ay nagre-redact ng karamihan sa mga payload maliban kung ang isang subsystem ay nag-opt in sa `privacy -off`. Ayon sa write-up ni Peter tungkol sa macOS [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025), ito ay kinokontrol ng isang plist sa `/Library/Preferences/Logging/Subsystems/` na naka-key sa pangalan ng subsystem. Tanging mga bagong log entry lamang ang kumukuha ng flag, kaya i-enable ito bago mag-reproduce ng isyu.

## Paganahin para sa OpenClaw (`bot.molt`)

- Isulat muna ang plist sa isang temp file, pagkatapos ay i-install ito nang atomically bilang root:

```bash
cat <<'EOF' >/tmp/bot.molt.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/bot.molt.plist /Library/Preferences/Logging/Subsystems/bot.molt.plist
```

- Walang kinakailangang reboot; mabilis na napapansin ng logd ang file, ngunit ang mga bagong linya ng log lamang ang magsasama ng mga pribadong payload.
- Tingnan ang mas mayamang output gamit ang umiiral na helper, hal. `./scripts/clawlog.sh --category WebChat --last 5m`.

## I-disable pagkatapos mag-debug

- Alisin ang override: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- Opsyonal na patakbuhin ang `sudo log config --reload` para pilitin ang logd na agad alisin ang override.
- Tandaan na maaaring maglaman ang surface na ito ng mga numero ng telepono at nilalaman ng mensahe; panatilihin lamang ang plist habang aktibo mong kailangan ang dagdag na detalye.
