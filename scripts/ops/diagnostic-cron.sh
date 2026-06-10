#!/usr/bin/env bash
#
# diagnostic-cron.sh — unattended daily fleet diagnostic (OS-cron entrypoint)
# ─────────────────────────────────────────────────────────────────────────────
# Wraps agents_server_diagnostic.sh for cron: syncs the repo, runs the scan
# (which rewrites the AUTOSCAN block in bug_list.md), commits + pushes the
# refreshed bug list, and emails the full report to the ops address.
#
# Everything here is deterministic — no LLM. Install via crontab, e.g.:
#   0 8 * * *  /bin/bash /root/projects/openclaw/scripts/ops/diagnostic-cron.sh >> /var/log/agentglob-diag.log 2>&1
#
set -uo pipefail

# Cron runs with a minimal environment — pin PATH and key locations explicitly.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export SSH_KEY=/root/.ssh/hetzner-openclaw
REPO=/root/projects/openclaw
EMAIL_TO=liran@agentglob.com
EMAIL_FROM="AgentGlob Diagnostics <onetrue2023@gmail.com>"
BUG_LIST_URL=https://github.com/cryptolir/openclaw/blob/main/scripts/ops/bug_list.md

cd "$REPO" || { echo "FATAL: $REPO not found"; exit 1; }

echo "═══════════════════════════════════════════════════════════════"
echo "diagnostic-cron run @ $(date '+%Y-%m-%d %H:%M:%S %Z')"

# 1. Start from a clean bug_list so `git pull` never collides with the last
#    run's uncommitted AUTOSCAN write, then sync to latest main.
git checkout -- scripts/ops/bug_list.md 2>/dev/null || true
git pull -q --rebase origin main || echo "WARN: git pull failed; continuing with local tree"

# 2. Run the scan (writes the AUTOSCAN block) and capture the full report.
REPORT="$(/bin/bash scripts/ops/agents_server_diagnostic.sh all 2>&1)"
echo "$REPORT"

# 2.5 Archive untracked cruft from the hosts' /opt/openclaw checkouts (OB-7)
#     so it can't collide with deploy-time `git pull`. Move — never delete —
#     into /root/openclaw-cruft-archive/<date>/ on each host. Only clearly
#     stale patterns (*.bak, .archive-*) older than 7 days are touched;
#     soul.md and status/ are deliberately left alone (soul.md seeds new
#     agents' SOUL.md during provisioning).
for H in 89.167.70.46 5.161.84.219; do
  ssh -i "$SSH_KEY" -o ConnectTimeout=15 -o BatchMode=yes "root@$H" '
    cd /opt/openclaw 2>/dev/null || exit 0
    ARCHIVE="/root/openclaw-cruft-archive/$(date +%F)"
    FILES=$(find . -maxdepth 2 \( -name "*.bak" -o -name ".archive-*" \) -mtime +7 2>/dev/null)
    [ -n "$FILES" ] || exit 0
    mkdir -p "$ARCHIVE"
    N=$(printf "%s\n" "$FILES" | wc -l)
    printf "%s\n" "$FILES" | xargs -I{} mv {} "$ARCHIVE/"
    echo "→ cruft-archive: moved $N item(s) to $ARCHIVE"
  ' 2>/dev/null || echo "WARN: cruft-archive skipped for $H (ssh failed)"
done

# 3. Commit + push the refreshed bug list (only if it actually changed).
if ! git diff --quiet scripts/ops/bug_list.md 2>/dev/null; then
  git add scripts/ops/bug_list.md
  git commit -q -m "ops: automated bug_list AUTOSCAN refresh $(date +%F)" \
    && git push -q origin main \
    && echo "→ bug_list.md committed + pushed" \
    || echo "WARN: commit/push failed"
else
  echo "→ bug_list.md unchanged; nothing to push"
fi

# 4. Email the report. Subject carries the P0..P3 totals at a glance.
COUNTS="$(printf '%s\n' "$REPORT" | grep -oE 'Totals:.*' | tail -1)"
SUBJECT="[AgentGlob] Fleet diagnostic $(date +%F) — ${COUNTS:-scan complete}"
if command -v msmtp >/dev/null 2>&1; then
  {
    printf 'Subject: %s\n' "$SUBJECT"
    printf 'From: %s\n' "$EMAIL_FROM"
    printf 'To: %s\n' "$EMAIL_TO"
    printf 'Content-Type: text/plain; charset=UTF-8\n\n'
    printf '%s\n\n' "$REPORT"
    printf 'Bug list: %s\n' "$BUG_LIST_URL"
  } | msmtp "$EMAIL_TO" \
      && echo "→ summary emailed to $EMAIL_TO" \
      || echo "WARN: email send failed — check ~/.msmtp.log and the Gmail app password in ~/.msmtprc"
else
  echo "WARN: msmtp not installed; skipping email"
fi

echo "diagnostic-cron done @ $(date '+%H:%M:%S %Z')"
