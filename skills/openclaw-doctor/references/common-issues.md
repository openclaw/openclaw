# Common OpenClaw Gateway Issues

## 1. Zombie Chrome/Playwright processes

**Symptoms:** High memory, gateway slow/unresponsive, systemd journal shows "left-over process (chrome)"
**Diagnosis:** `ps aux | grep chrome`, `pgrep -f 'ms-playwright.*chrome'`
**Fix:** `pkill -f 'ms-playwright.*chrome'`, then restart gateway if needed

## 2. OOM Kill

**Symptoms:** Gateway suddenly stops, `dmesg | grep -i oom` shows kill
**Diagnosis:** `free -h`, `dmesg | tail -30`, journal shows SIGKILL
**Fix:** Clean page cache (`sync && echo 3 > /proc/sys/vm/drop_caches`), restart, consider reducing browser tool usage

## 3. Port conflict (EADDRINUSE)

**Symptoms:** Gateway won't start, logs show "EADDRINUSE" or "another gateway instance"
**Diagnosis:** `ss -tlnp | grep 18789`
**Fix:** Kill conflicting process, restart

## 4. Config errors after upgrade

**Symptoms:** Gateway won't start, "gateway start blocked" or "refusing to bind"
**Diagnosis:** `openclaw doctor`, `openclaw gateway status`
**Fix:** Check `gateway.mode`, `gateway.auth.*` settings. Run `openclaw configure` if needed.

## 5. Channel disconnect (Telegram)

**Symptoms:** Messages not delivered, "logged out" in logs
**Diagnosis:** `openclaw channels status --probe`
**Fix:** Check bot token, relink if needed

## 6. Disk full (ENOSPC)

**Symptoms:** Write errors, logs stop, gateway may crash
**Diagnosis:** `df -h /`
**Fix:** Clean old logs (`find /tmp/openclaw/ -name "*.log" -mtime +7 -delete`), clean npm cache

## 7. Anthropic 429 (rate limit)

**Symptoms:** "HTTP 429: rate_limit_error" in logs
**Diagnosis:** `openclaw logs --follow | grep 429`
**Fix:** Wait, or configure fallback models in config

## 8. Node.js heap out of memory

**Symptoms:** "FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory"
**Diagnosis:** Journal shows SIGABRT or heap error
**Fix:** Set `NODE_OPTIONS=--max-old-space-size=1024` in service env, restart
