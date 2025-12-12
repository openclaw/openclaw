---
summary: "Clawdis logging: rolling diagnostics file log + unified log privacy flags"
read_when:
  - Capturing macOS logs or investigating private data logging
  - Debugging voice wake/session lifecycle issues
---
# Logging (macOS)

## Rolling diagnostics file log (Debug pane)
Clawdis can write a local, rotating diagnostics log to disk (useful when macOS unified logging is impractical during iterative repros).

- Enable: **Debug pane → Diagnostics log → “Write rolling diagnostics log (JSONL)”**
- Location: `~/Library/Logs/Clawdis/diagnostics.jsonl` (rotates automatically; old files are suffixed with `.1`, `.2`, …)
- Clear: **Debug pane → Diagnostics log → “Clear”**

Notes:
- This is **off by default**. Enable only while actively debugging.
- Treat the file as sensitive; don’t share it without review.

## Unified logging private data on macOS

Unified logging redacts most payloads unless a subsystem opts into `privacy -off`. Per Peter's write-up on macOS [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) this is controlled by a plist in `/Library/Preferences/Logging/Subsystems/` keyed by the subsystem name. Only new log entries pick up the flag, so enable it before reproducing an issue.

## Enable for Clawdis (`com.steipete.clawdis`)
- Write the plist to a temp file first, then install it atomically as root:

```bash
cat <<'EOF' >/tmp/com.steipete.clawdis.plist
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
sudo install -m 644 -o root -g wheel /tmp/com.steipete.clawdis.plist /Library/Preferences/Logging/Subsystems/com.steipete.clawdis.plist
```

- No reboot is required; logd notices the file quickly, but only new log lines will include private payloads.
- View the richer output with the existing helper, e.g. `./scripts/clawlog.sh --category WebChat --last 5m`.

## Disable after debugging
- Remove the override: `sudo rm /Library/Preferences/Logging/Subsystems/com.steipete.clawdis.plist`.
- Optionally run `sudo log config --reload` to force logd to drop the override immediately.
- Remember this surface can include phone numbers and message bodies; keep the plist in place only while you actively need the extra detail.
