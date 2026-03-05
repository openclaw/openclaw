#!/bin/bash
# operator-audit-logger.sh - Append-only audit log for operator actions

AUDIT_LOG="/var/log/fridaclaw/operator-audit.log"

log_audit() {
  local event="$1"
  local details="$2"
  echo "$(date -Iseconds) $event $details" >> "$AUDIT_LOG"
}

# Log SSH logins
echo "session required pam_exec.so /usr/local/bin/log-ssh-login.sh" >> /etc/pam.d/sshd

# Log openclaw CLI invocations
cat >> /etc/profile.d/openclaw-audit.sh <<'EOF'
if [[ "$1" == "openclaw" ]]; then
  echo "$(date -Iseconds) OPENCLAW_CMD $*" >> /var/log/fridaclaw/operator-audit.log
fi
EOF
