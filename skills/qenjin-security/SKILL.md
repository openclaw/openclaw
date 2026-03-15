---
name: qenjin-security
description: Server security monitoring — active connections, fail2ban status, Docker exposure, port audit.
user-invocable: true
disable-model-invocation: false
triggers:
  - /security
  - /sec
  - /audit
---

# qenjin-security

Server security posture check. Hetzner backend (91.99.61.195) via SSH.
SSH config: `~/.ssh/config` entry `Hetzner`.

## On `/security status`

Quick posture check. Fail2ban bans, UFW status, active SSH sessions, last logins.

```bash
ssh Hetzner "
echo '=== UFW STATUS ==='
ufw status numbered | head -20

echo ''
echo '=== FAIL2BAN ==='
fail2ban-client status sshd 2>/dev/null | grep -E 'Currently banned|Total banned|Banned IP'

echo ''
echo '=== ACTIVE CONNECTIONS ==='
ss -tnp | grep ESTAB | awk '{print \$4, \$5, \$7}' | head -20

echo ''
echo '=== LAST LOGINS ==='
last | head -10
"
```

Reply format:
```
UFW: active, N rules
Fail2ban: N currently banned, N total
Active connections: N
Last login: <user> from <IP> at <time>
```

## On `/security ports`

Open ports and listening services.

```bash
ssh Hetzner "ss -tlnp | grep -v '127.0.0.1' | grep -v '::1'"
```

Review against expected ports:
- `443/tcp` — Traefik HTTPS (expected)
- `80/tcp` — Traefik HTTP redirect (expected)
- `22/tcp` — SSH (expected, key-only)
- Any other public port: flag for review

Reply with full list. Flag anything unexpected with `⚠️ UNEXPECTED:`.

## On `/security docker`

Check Docker container exposure — which containers have ports bound to 0.0.0.0 (public-facing).

```bash
ssh Hetzner "docker ps --format 'table {{.Names}}\t{{.Ports}}' | grep '0.0.0.0'"
```

Expected: only Traefik should bind to 0.0.0.0:443 and 0.0.0.0:80.
All other containers: Traefik-proxied only, no direct port exposure.

Flag any container other than Traefik with `0.0.0.0:*` bindings.

## On `/security bans`

Recent fail2ban bans. Who's being blocked and why.

```bash
ssh Hetzner "
echo '=== SSHD BANS ==='
fail2ban-client status sshd 2>/dev/null

echo ''
echo '=== RECENT BAN LOG ==='
grep -i 'ban\|unban' /var/log/fail2ban.log 2>/dev/null | tail -20

echo ''
echo '=== AUTH FAILURES (last 1h) ==='
journalctl -u ssh --since '1 hour ago' | grep -i 'failed\|invalid\|refused' | tail -20
"
```

## On `/security logs [service]`

Tail logs for a specific service. Services: `traefik`, `nginx`, `ssh`, `docker`.

```bash
python3 -c "
import subprocess, sys

ALLOWED = {'traefik', 'nginx', 'ssh', 'docker'}
service = sys.argv[1] if len(sys.argv) > 1 else ''
if service not in ALLOWED:
    print(f'Unknown service. Allowed: {', '.join(sorted(ALLOWED))}')
    exit()

# Build SSH command with validated service name
r = subprocess.run([
    'ssh', 'Hetzner',
    f'journalctl -u {service} --since \"24 hours ago\" --no-pager | grep -i \"error|warn|fail|denied\" | tail -30'
], capture_output=True, text=True)
print(r.stdout or r.stderr or 'No output.')
" <service>
```

## On `/security certs`

TLS certificate expiry check for all active domains.

```bash
python3 -c "
import subprocess, json
from datetime import datetime

domains = [
    'hudafilm.com', 'growmind.space', 'qenjin.io',
    'campaigns.hudafilm.com', 'crm.huda20.fun', 'n8n.huda20.fun',
    'analytics.huda20.fun', 'cal.huda20.fun', 'si.qenjin.io'
]

for domain in domains:
    r = subprocess.run([
        'curl', '-vI', '--max-time', '5', f'https://{domain}'
    ], capture_output=True, text=True)
    # Parse expiry from stderr (curl -v output)
    for line in r.stderr.splitlines():
        if 'expire date' in line.lower():
            print(f'{domain}: {line.strip()}')
            break
    else:
        print(f'{domain}: cert check failed or no HTTPS')
"
```

## On `/security full`

Full audit: ports + docker exposure + bans + recent auth failures + cert expiry.
Runs all checks above sequentially. Useful for weekly security review.

Output each section with a clear header. Flag anomalies with `⚠️`.

## Rules

- Read-only operations only. Never modify firewall rules, restart services, or delete anything via this skill.
- Always use SSH key auth (no password prompts expected).
- If SSH fails: `Cannot reach Hetzner — check connection or server status.`
- Security data stays in reply only. Never write to files.
- Findings that require action: report them, do NOT act. User decides next step.
- This skill reports. It does not remediate.
