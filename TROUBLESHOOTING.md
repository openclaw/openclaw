# OpenClaw Conflict & Hang Analysis

## Identified Issues

1. **Concurrent Session Conflicts:** Multiple `openclaw-tui` and `openclaw` instances accessing `openclaw.json` simultaneously.
2. **Configuration Corruption:** "Size-drop" detected in `openclaw.json` due to non-atomic writes during high-load sessions.
3. **Dispatcher Deadlock:** The dispatcher hangs when the downstream `watch-ceviz` (8080) backend is unreachable or unresponsive.
4. **Zombie Gateway Sessions:** Old gateway processes (PID 5670) remaining active and holding stale session states.
5. **WhatsApp Quota Drainage:** Sending large data blocks (logs, IP lists) to WhatsApp triggers excessive token usage and potential "reply-loops," exhausting Gemini/OpenAI quotas within hours.

## Recommended Solutions

### Immediate (Manual)

- **Disable WhatsApp for Logs:** Never send large log files or raw IP lists via WhatsApp. Use the CLI or file-based interaction for large data.
- **Quota Recovery:** If Gemini stops responding, wait for the daily reset (usually 24 hours) and keep WhatsApp `enabled: false` until the session is cleared.
- **Deep Session Flush:** Use the "Emergency Reset" then `rm -rf ~/.openclaw/agents/main/sessions/*` to kill any pending WhatsApp message loops.

### Architectural (Future)

- **Atomic Config Updates:** Implement a temp-file-and-rename pattern for `openclaw.json`.
- **Fail-Fast Circuits:** Add short timeouts (e.g., 5s) for all external tool/backend calls to prevent dispatcher hangs.
- **Single-Instance Lock:** Implement a `.pid` file or socket lock to prevent multiple TUI instances from running for the same user.

## Emergency Reset Command

```bash
pkill -f openclaw; pkill -f openclaw-tui; pkill -f openclaw-gateway;
```
