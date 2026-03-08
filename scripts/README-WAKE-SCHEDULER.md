# OpenClaw Wake Scheduler

**Universal scheduler to keep your OpenClaw/ResonantOS gateway responsive**

[![Platform Support](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20BSD-blue)]()
[![Testing Status](https://img.shields.io/badge/Windows-Tested%20%E2%9C%85-green)]()
[![Testing Status](https://img.shields.io/badge/Unix%2FLinux-Experimental%20%E2%9A%A0%EF%B8%8F-yellow)]()

---

## Overview

The OpenClaw Wake Scheduler automatically sends periodic wake signals to your OpenClaw gateway, preventing it from becoming unresponsive due to hangs or crashes. It acts as a "defibrillator" for your AI assistant, ensuring 24/7 availability.

**What it does:**
- Sends wake signals every 5 minutes during active hours (7 AM - 2 AM)
- Sends wake signals every 15 minutes during sleep hours (3 AM - 7 AM)
- Auto-recovers from gateway hangs/crashes
- Works across 10+ operating systems

**What it doesn't do:**
- Does NOT restart the gateway (just wakes it up if stuck)
- Does NOT require admin/root privileges (runs as your user)
- Does NOT make network calls (uses local openclaw CLI)

---

## Prerequisites

1. **Node.js 14+** (check with `node --version`)
2. **OpenClaw CLI installed and in PATH** (check with `which openclaw` or `where openclaw`)
3. **OpenClaw gateway running** (the wake scheduler will call `openclaw wake`)

---

## Platform Support

| Platform | Scheduler | Testing Status | Notes |
|----------|-----------|----------------|-------|
| **Windows 10/11** | Task Scheduler | ✅ **Fully Tested** | Production-ready |
| **macOS** | Cron / Launchd | ⚠️ **Experimental** | Code complete, untested |
| **Linux** | Cron / Systemd | ⚠️ **Experimental** | Code complete, untested |
| **Raspberry Pi** | Cron | ⚠️ **Experimental** | Code complete, untested |
| **WSL (Windows)** | Cron | ⚠️ **Experimental** | Auto-detected, untested |
| **FreeBSD / OpenBSD / NetBSD** | Cron | ⚠️ **Experimental** | Code complete, untested |
| **Solaris / Illumos** | Cron | ⚠️ **Experimental** | Code complete, untested |
| **AIX** | Cron | ⚠️ **Experimental** | Code complete, untested |
| **Android (Termux)** | Cron | ⚠️ **Experimental** | Requires `pkg install cronie` |

---

## Installation

### Windows

```powershell
cd C:\Users\YourName\.openclaw\workspace\scripts
node install-wake-scheduler-unified.js
```

**Expected output:**
```
✅ Installation complete!
Environment: OpenClaw
Method: Task Scheduler
Verification: ✅ Passed
```

**Verify installation:**
```powershell
schtasks /query /tn "OpenClaw\LocalDocWake"
```

---

### macOS

```bash
cd ~/.openclaw/workspace/scripts
node install-wake-scheduler-unified.js
```

**Expected output:**
```
✅ Installation complete!
Method: Cron (or Launchd)
Verification: ✅ Passed
```

**Verify installation:**
```bash
crontab -l | grep openclaw
# OR
launchctl list | grep openclaw
```

⚠️ **Note:** macOS may prompt for approval in **System Preferences > Security & Privacy** if using Launchd. Approve the agent if prompted.

---

### Linux

```bash
cd ~/.openclaw/workspace/scripts
node install-wake-scheduler-unified.js
```

**For Systemd (requires root/sudo):**
```bash
sudo node install-wake-scheduler-unified.js
```

**Expected output:**
```
✅ Installation complete!
Method: Cron (or Systemd Timer)
Verification: ✅ Passed
```

**Verify installation:**
```bash
crontab -l | grep openclaw
# OR
systemctl status openclaw-wake.timer
```

⚠️ **Note:** Systemd requires root/sudo privileges. If you don't have sudo, the installer will automatically fall back to cron (which runs as your user).

---

### Raspberry Pi / ARM

Same as Linux above. The installer auto-detects ARM architecture.

---

### WSL (Windows Subsystem for Linux)

The installer auto-detects WSL and uses cron (not Windows Task Scheduler).

```bash
cd ~/.openclaw/workspace/scripts
node install-wake-scheduler-unified.js
```

---

### Android (Termux)

**Prerequisites:**
```bash
pkg install nodejs cronie
```

**Installation:**
```bash
cd ~/.openclaw/workspace/scripts
node install-wake-scheduler-unified.js
```

---

## Configuration

### Default Settings

```javascript
wakeInterval: 5 minutes   // Active hours (7 AM - 2 AM)
sleepInterval: 15 minutes // Sleep hours (3 AM - 7 AM)
activeHoursStart: 7       // 7 AM
activeHoursEnd: 2         // 2 AM (next day)
timezone: Auto-detected   // Uses system timezone
```

### Customization (Optional)

**Edit the script before installation:**

```javascript
// Open install-wake-scheduler-unified.js
// Find the CONFIG section (around line 60)
const CONFIG = {
  wakeInterval: 10,      // Change to 10 minutes
  sleepInterval: 30,     // Change to 30 minutes
  activeHoursStart: 8,   // Start at 8 AM instead of 7 AM
  activeHoursEnd: 1,     // End at 1 AM instead of 2 AM
  timezone: 'America/Los_Angeles', // Override auto-detection
  // ...
};
```

**CLI flags (coming soon):**
```bash
node install-wake-scheduler-unified.js --interval 10 --timezone "America/Los_Angeles"
```

---

## Verification

After installation, check that wake signals are being sent:

### Check Logs
```bash
# Windows
type C:\Users\YourName\.openclaw\workspace\scripts\wake-scheduler.log

# Unix/Linux/macOS
tail -f ~/.openclaw/workspace/scripts/wake-scheduler.log
```

### Manual Test
```bash
# Windows
schtasks /run /tn "OpenClaw\LocalDocWake"

# Unix/Linux/macOS
# The scheduler will run automatically on its interval
# You can test the openclaw CLI directly:
openclaw wake --text "Manual test"
```

---

## Troubleshooting

### "openclaw: command not found"

**Cause:** OpenClaw CLI is not in your PATH.

**Fix:**
1. Find where openclaw is installed:
   ```bash
   # macOS/Linux
   find / -name openclaw 2>/dev/null
   
   # Windows
   where openclaw
   ```

2. Add to PATH or create symlink:
   ```bash
   # macOS/Linux
   sudo ln -s /path/to/openclaw /usr/local/bin/openclaw
   
   # Windows
   # Add C:\path\to\openclaw to System PATH in Environment Variables
   ```

---

### Windows: "Task already exists"

**Cause:** Scheduler was previously installed.

**Fix:** Delete the old task first:
```powershell
schtasks /delete /tn "OpenClaw\LocalDocWake" /f
node install-wake-scheduler-unified.js
```

---

### Linux: "Systemd requires root/sudo"

**Cause:** Systemd timer installation needs root privileges.

**Fix (Option 1):** Use sudo:
```bash
sudo node install-wake-scheduler-unified.js
```

**Fix (Option 2):** Let it fall back to cron (automatic):
```bash
node install-wake-scheduler-unified.js
# Will automatically use cron if systemd fails
```

---

### macOS: "Operation not permitted"

**Cause:** Modern macOS requires explicit approval for launch agents.

**Fix:**
1. Open **System Preferences > Security & Privacy**
2. Look for a message about the wake scheduler
3. Click **Allow**
4. Re-run the installer if needed

---

### "Verification failed: Command failed"

**Cause:** OpenClaw gateway is not running, or `openclaw wake` command failed.

**Fix:**
1. Check if the gateway is running:
   ```bash
   openclaw status
   ```

2. Start the gateway if stopped:
   ```bash
   openclaw gateway start
   ```

3. Test the wake command manually:
   ```bash
   openclaw wake --text "Test"
   ```

4. Re-run the installer once the gateway is working.

---

### Cron: "No crontab for user"

**Cause:** You've never used cron before (this is normal).

**Fix:** The installer handles this automatically. No action needed.

---

### Logs not appearing

**Cause:** Log file permissions or path issue.

**Fix:**
```bash
# Check log file location
ls -la ~/.openclaw/workspace/scripts/wake-scheduler.log

# If missing, the installer will create it on next run
```

---

## Uninstallation

### Windows

```powershell
schtasks /delete /tn "OpenClaw\LocalDocWake" /f
```

### macOS / Linux

```bash
# Remove cron entries
crontab -e
# Delete lines containing "openclaw-wake-scheduler"

# OR use the uninstall script (if available)
node uninstall-wake-scheduler.js
```

### Systemd (Linux)

```bash
sudo systemctl stop openclaw-wake.timer
sudo systemctl disable openclaw-wake.timer
sudo rm /etc/systemd/system/openclaw-wake.service
sudo rm /etc/systemd/system/openclaw-wake.timer
sudo systemctl daemon-reload
```

---

## Security

- **No admin/root required** (except for Systemd on Linux)
- **Files created with restrictive permissions** (0o600 for config, 0o700 for scripts)
- **No network access** (calls local `openclaw` CLI only)
- **No sensitive data stored** (just wake signal scheduling)
- **Open source** (inspect the code before running)

For security issues, see [SECURITY.md](../SECURITY.md).

---

## FAQ

**Q: Will this drain my battery on a laptop?**  
A: No. Wake signals are lightweight CLI calls (~10ms each). Negligible CPU/battery impact.

**Q: What if my computer is asleep/hibernating?**  
A: The scheduler won't run while the system is asleep. It resumes automatically when you wake the computer.

**Q: Can I run this on multiple machines?**  
A: Yes! Each machine can have its own wake scheduler. They won't conflict.

**Q: Does this work with ResonantOS?**  
A: Yes! The installer auto-detects ResonantOS and works identically.

**Q: What happens if the gateway crashes?**  
A: The scheduler will keep sending wake signals. If the gateway has a proper watchdog/supervisor, it will auto-restart on wake.

**Q: Can I change the wake intervals after installation?**  
A: Edit the generated script (PowerShell on Windows, shell script on Unix) or re-run the installer with updated CONFIG values.

---

## Support

- **GitHub Issues:** [openclaw/openclaw/issues](https://github.com/openclaw/openclaw/issues)
- **Discord:** [openclaw.ai/discord](https://openclaw.ai/discord) (#support channel)
- **Documentation:** [docs.openclaw.ai](https://docs.openclaw.ai)

---

## Contributing

Found a bug? Want to test on a new platform? Contributions welcome!

See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.

---

## License

MIT License - see [LICENSE](../LICENSE) for details.

---

## Credits

**Built by:** Dr. Tom Pennington (Local Doc)  
**Security Review:** Claude Sonnet 4.5, GPT-4o  
**Version:** 1.2.0-production  
**Date:** 2026-02-26

🦞 *With love for the OpenClaw community*
