---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "OpenClaw logging: rolling diagnostics file log + unified log privacy flags"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Capturing macOS logs or investigating private data logging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging voice wake/session lifecycle issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "macOS Logging"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Logging (macOS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Rolling diagnostics file log (Debug pane)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw routes macOS app logs through swift-log (unified logging by default) and can write a local, rotating file log to disk when you need a durable capture.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verbosity: **Debug pane → Logs → App logging → Verbosity**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enable: **Debug pane → Logs → App logging → “Write rolling diagnostics log (JSONL)”**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Location: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (rotates automatically; old files are suffixed with `.1`, `.2`, …)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Clear: **Debug pane → Logs → App logging → “Clear”**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- This is **off by default**. Enable only while actively debugging.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Treat the file as sensitive; don’t share it without review.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Unified logging private data on macOS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Unified logging redacts most payloads unless a subsystem opts into `privacy -off`. Per Peter's write-up on macOS [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) this is controlled by a plist in `/Library/Preferences/Logging/Subsystems/` keyed by the subsystem name. Only new log entries pick up the flag, so enable it before reproducing an issue.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Enable for OpenClaw (`bot.molt`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Write the plist to a temp file first, then install it atomically as root:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cat <<'EOF' >/tmp/bot.molt.plist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<?xml version="1.0" encoding="UTF-8"?>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<plist version="1.0">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<dict>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <key>DEFAULT-OPTIONS</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    <dict>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        <key>Enable-Private-Data</key>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        <true/>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    </dict>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</dict>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</plist>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
EOF（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo install -m 644 -o root -g wheel /tmp/bot.molt.plist /Library/Preferences/Logging/Subsystems/bot.molt.plist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No reboot is required; logd notices the file quickly, but only new log lines will include private payloads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- View the richer output with the existing helper, e.g. `./scripts/clawlog.sh --category WebChat --last 5m`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Disable after debugging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remove the override: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optionally run `sudo log config --reload` to force logd to drop the override immediately.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remember this surface can include phone numbers and message bodies; keep the plist in place only while you actively need the extra detail.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
