#!/usr/bin/env bash
# Patch OpenClaw feishu extension:
# 1. reply_in_thread: true for all im.message.reply calls (send.ts)
# 2. DM topic session isolation support (bot.ts)
# 3. Reply to thread root instead of individual message (bot.ts)
# 4. Group timeline parallel sessions — each message gets its own session (bot.ts)
# 5. Fire-and-forget message handling — never block event loop (monitor.ts)
#
# Run after `openclaw update` to re-apply patches
#
# Usage: bash extensions/feishu/scripts/patch-feishu-group-ux.sh

set -euo pipefail

FEISHU_SRC="/opt/homebrew/lib/node_modules/openclaw/extensions/feishu/src"
SEND_TS="$FEISHU_SRC/send.ts"
BOT_TS="$FEISHU_SRC/bot.ts"
MONITOR_TS="$FEISHU_SRC/monitor.ts"

# --- Patch 1: reply_in_thread in send.ts ---

if [[ ! -f "$SEND_TS" ]]; then
  echo "ERROR: $SEND_TS not found"
  exit 1
fi

if grep -q 'reply_in_thread: true' "$SEND_TS"; then
  echo "[send.ts] Already patched — reply_in_thread: true"
else
  sed -i '' '/data: {/{
N
N
/msg_type:.*,$/a\
\        reply_in_thread: true,
}' "$SEND_TS"

  if grep -q 'reply_in_thread: true' "$SEND_TS"; then
    count=$(grep -c 'reply_in_thread: true' "$SEND_TS")
    echo "[send.ts] Patched — $count reply_in_thread insertions"
  else
    echo "ERROR: send.ts patch failed"
    exit 1
  fi
fi

# --- Patch 2: Group parallel sessions + DM topic session isolation in bot.ts ---
# Original: only messages with rootId get topic sessions.
# Patched: group timeline messages (no rootId) use messageId as topic key,
#          so every message in the group timeline gets its own session (parallel).
#          DM messages with rootId also get topic sessions.

if [[ ! -f "$BOT_TS" ]]; then
  echo "ERROR: $BOT_TS not found"
  exit 1
fi

if grep -q 'const topicKey = ctx.rootId ?? ctx.messageId' "$BOT_TS"; then
  echo "[bot.ts] Already patched — group parallel sessions + DM topic isolation"
else
  python3 -c "
import sys

f = '$BOT_TS'
content = open(f).read()

# Match the upstream original block (before any of our patches)
old = '''    if (ctx.rootId) {
      if (isGroup) {
        const groupConfig = resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: ctx.chatId });
        const topicSessionMode =
          groupConfig?.topicSessionMode ?? feishuCfg?.topicSessionMode ?? \"disabled\";
        if (topicSessionMode === \"enabled\") {
          peerId = \\\`\\\${ctx.chatId}:topic:\\\${ctx.rootId}\\\`;
          log(\\\`feishu[\\\${account.accountId}]: topic session isolation enabled, peer=\\\${peerId}\\\`);
        }
      } else {
        // DM topic session isolation
        const topicSessionMode = feishuCfg?.topicSessionMode ?? \"disabled\";
        if (topicSessionMode === \"enabled\") {
          peerId = \\\`\\\${ctx.senderOpenId}:topic:\\\${ctx.rootId}\\\`;
          log(\\\`feishu[\\\${account.accountId}]: DM topic session isolation enabled, peer=\\\${peerId}\\\`);
        }
      }
    }'''

new = '''    if (isGroup) {
      const groupConfig = resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: ctx.chatId });
      const topicSessionMode =
        groupConfig?.topicSessionMode ?? feishuCfg?.topicSessionMode ?? \"disabled\";
      if (topicSessionMode === \"enabled\") {
        // Use rootId for thread replies, messageId for timeline messages
        const topicKey = ctx.rootId ?? ctx.messageId;
        peerId = \\\`\\\${ctx.chatId}:topic:\\\${topicKey}\\\`;
        log(\\\`feishu[\\\${account.accountId}]: topic session isolation enabled, peer=\\\${peerId}\\\`);
      }
    } else if (ctx.rootId) {
      // DM topic session isolation
      const topicSessionMode = feishuCfg?.topicSessionMode ?? \"disabled\";
      if (topicSessionMode === \"enabled\") {
        peerId = \\\`\\\${ctx.senderOpenId}:topic:\\\${ctx.rootId}\\\`;
        log(\\\`feishu[\\\${account.accountId}]: DM topic session isolation enabled, peer=\\\${peerId}\\\`);
      }
    }'''

if old not in content:
    print('ERROR: original block not found in bot.ts (already patched or upstream changed)')
    sys.exit(1)

open(f, 'w').write(content.replace(old, new, 1))
print('[bot.ts] Patched — group parallel sessions + DM topic isolation')
"
fi

# --- Patch 3: Reply to thread root in bot.ts ---
# When a message arrives in a thread (has root_id), reply to the thread root
# instead of the individual message. This keeps replies in the same thread
# rather than creating a new sub-thread.

if grep -q 'ctx.rootId || ctx.messageId' "$BOT_TS"; then
  echo "[bot.ts] Already patched — reply to thread root"
else
  sed -i '' 's/replyToMessageId: ctx\.messageId/replyToMessageId: ctx.rootId || ctx.messageId/g' "$BOT_TS"

  if grep -q 'ctx.rootId || ctx.messageId' "$BOT_TS"; then
    count=$(grep -c 'ctx.rootId || ctx.messageId' "$BOT_TS")
    echo "[bot.ts] Patched — $count replyToMessageId -> thread root replacements"
  else
    echo "ERROR: bot.ts thread root patch failed"
    exit 1
  fi
fi

# --- Patch 4: Fire-and-forget message handling in monitor.ts ---
# Original: WebSocket mode awaits each message handler, blocking the event loop.
# Patched: always fire-and-forget so messages are processed in parallel.

if [[ ! -f "$MONITOR_TS" ]]; then
  echo "ERROR: $MONITOR_TS not found"
  exit 1
fi

if ! grep -q 'await promise' "$MONITOR_TS"; then
  echo "[monitor.ts] Already patched — fire-and-forget mode"
else
  python3 -c "
import sys

f = '$MONITOR_TS'
content = open(f).read()

old = '''        if (fireAndForget) {
          promise.catch((err) => {
            error(\\\`feishu[\\\${accountId}]: error handling message: \\\${String(err)}\\\`);
          });
        } else {
          await promise;
        }'''

new = '''        // Always fire-and-forget: never block the event loop waiting for dispatch.
        // Each message gets its own session (via topicSessionMode), so parallel is safe.
        promise.catch((err) => {
          error(\\\`feishu[\\\${accountId}]: error handling message: \\\${String(err)}\\\`);
        });'''

if old not in content:
    print('ERROR: original block not found in monitor.ts (already patched or upstream changed)')
    sys.exit(1)

open(f, 'w').write(content.replace(old, new, 1))
print('[monitor.ts] Patched — fire-and-forget mode enabled')
"
fi

# --- Reload gateway ---
GATEWAY_PID=$(pgrep -f "openclaw" 2>/dev/null | head -1)
if [[ -n "$GATEWAY_PID" ]]; then
  kill -HUP "$GATEWAY_PID"
  echo "Sent SIGHUP to openclaw gateway (PID $GATEWAY_PID)"
else
  echo "WARNING: openclaw gateway not running, skip reload"
fi
