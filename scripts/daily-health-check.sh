#!/bin/bash
# Daily health check for OpenClaw
set +H
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
DOCKER=$(which docker || echo /opt/homebrew/bin/docker)
LOG_DIR=~/openclaw/logs
mkdir -p "$LOG_DIR"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "$TS Starting health check"

# 1. Container running?
RUNNING=$($DOCKER ps --format '{{.Names}}' | grep -c openclaw-agent)
if [ "$RUNNING" -eq 0 ]; then
  echo "$TS ERROR: openclaw-agent not running"
  exit 1
fi

# 2. Uptime
STARTED=$($DOCKER inspect --format '{{.State.StartedAt}}' openclaw-agent 2>/dev/null)
echo "$TS Container started: $STARTED"

# 3. Telegram polling check with timeout and retry (filter stderr noise)
PENDING=$($DOCKER exec openclaw-agent node -e "
const cfg = require('/home/node/.openclaw/openclaw.json');
const token = cfg.channels.telegram.botToken;
if (!token) { console.log(-2); process.exit(0); }

async function checkTelegram(attempt = 1) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const r = await fetch('https://api.telegram.org/bot' + token + '/getWebhookInfo', {
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!r.ok) {
      console.log(-3); // API error
      return;
    }

    const d = await r.json();
    if (d?.result?.pending_update_count !== undefined) {
      console.log(d.result.pending_update_count);
    } else {
      console.log(-4); // Invalid response
    }
  } catch (err) {
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 500)); // Wait 500ms before retry
      await checkTelegram(attempt + 1);
    } else {
      console.log(-1); // Failed after 2 attempts
    }
  }
}

checkTelegram().catch(()=>console.log(-1));
" 2>/dev/null | grep -E '^-?[0-9]+$' | tail -1)
PENDING=${PENDING:-0}
echo "$TS Telegram pending updates: $PENDING"
if [ "$PENDING" -gt 5 ] 2>/dev/null; then
  echo "$TS WARNING: Telegram has $PENDING pending updates, possible polling issue"
  if [ "$PENDING" -gt 10 ] 2>/dev/null; then
    echo "$TS Auto-restarting openclaw-agent due to $PENDING pending updates"
    $DOCKER restart openclaw-agent
  fi
fi

# 4. Session sizes
LARGE_SESSIONS=$($DOCKER exec openclaw-agent find /home/node/.openclaw/agents/main/sessions -name '*.jsonl' -size +200k 2>/dev/null | wc -l | tr -d ' ')
echo "$TS Large sessions (>200KB): $LARGE_SESSIONS"

# 5. Wrapper proxy
WRAPPER=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3457/v1/models 2>/dev/null)
echo "$TS Wrapper proxy status: $WRAPPER"

# 6. Write metrics
echo "{\"ts\":\"$TS\",\"container\":\"running\",\"telegram_pending\":$PENDING,\"large_sessions\":$LARGE_SESSIONS,\"wrapper_status\":\"$WRAPPER\"}" >> "$LOG_DIR/health-check-daily.jsonl"

echo "$TS Health check complete"
