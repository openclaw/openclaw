---
summary: "OpenClaw logging: unified log capture and privacy flags"
read_when:
  - Capturing macOS logs or investigating private data logging
  - Debugging voice wake/session lifecycle issues
title: "macOS logging"
---

# Logging (macOS)

## App Logging

OpenClaw routes macOS app logs through swift-log into unified logging. The app
does not write a separate JSONL diagnostics log; use Console.app, `log stream`,
or `./scripts/clawlog.sh` for durable captures.

- Verbosity: **Debug pane → Logs → App logging → Verbosity**

## Unified logging private data on macOS

Unified logging redacts most payloads unless a subsystem opts into `privacy -off`. Per Peter's write-up on macOS [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) this is controlled by a plist in `/Library/Preferences/Logging/Subsystems/` keyed by the subsystem name. Only new log entries pick up the flag, so enable it before reproducing an issue.

## Enable for OpenClaw (`ai.openclaw`)

- Write the plist to a temp file first, then install it atomically as root:

```bash
cat <<'EOF' >/tmp/ai.openclaw.plist
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
sudo install -m 644 -o root -g wheel /tmp/ai.openclaw.plist /Library/Preferences/Logging/Subsystems/ai.openclaw.plist
```

- No reboot is required; logd notices the file quickly, but only new log lines will include private payloads.
- View the richer output with the existing helper, e.g. `./scripts/clawlog.sh --category WebChat --last 5m`.

## Disable after debugging

- Remove the override: `sudo rm /Library/Preferences/Logging/Subsystems/ai.openclaw.plist`.
- Optionally run `sudo log config --reload` to force logd to drop the override immediately.
- Remember this surface can include phone numbers and message bodies; keep the plist in place only while you actively need the extra detail.

## Related

- [macOS app](/platforms/macos)
- [Gateway logging](/gateway/logging)
