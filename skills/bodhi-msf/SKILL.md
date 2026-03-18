---
name: bodhi-msf
description: Metasploit security testing — port scans, vuln scans, module runs — scoped strictly to owned infrastructure on bodhi1 local server.
user-invocable: true
disable-model-invocation: false
triggers:
  - /msf
  - /pentest
  - /exploit
  - /recon
---

# bodhi-msf

Metasploit Framework integration for authorized personal security testing. Runs on bodhi1 (192.168.0.247). Targets are hard-scoped to owned infrastructure only.

**Prerequisite — install once on bodhi1:**
```bash
sudo apt install -y metasploit-framework
msfdb init
```

## SCOPE — NEVER DEVIATE

```python
ALLOWED_TARGETS = {
    # LAN
    '192.168.0.0/24',
    # Tailscale
    '100.64.0.0/10',
    # Hetzner backend
    '91.99.61.195',
    # Hetzner frontend
    '135.181.80.99',
}
```

Any target not matching this list: reply `Out of scope. Only owned infrastructure may be tested.` and stop.

Scope check is mandatory before ANY msfconsole call.

---

## On `/msf status`

Check Metasploit is installed and database is running.

```bash
python3 -c "
import subprocess, shutil

if not shutil.which('msfconsole'):
    print('NOT_INSTALLED: run: sudo apt install metasploit-framework && msfdb init')
    exit()

r = subprocess.run(
    ['msfconsole', '-q', '-x', 'db_status; version; exit'],
    capture_output=True, text=True, timeout=30
)
print(r.stdout[-1000:] or r.stderr[-500:])
"
```

Reply format:
```
Metasploit: installed
DB: connected (postgresql)
Version: x.x.x
```

---

## On `/msf scan <target>`

Port scan via Metasploit's TCP scanner. Fast, SYN-style.

Scope-validate `<target>` first (see SCOPE).

```bash
BODHI_TARGET='<target>' python3 -c "
import subprocess, os, ipaddress

TARGET = os.environ.get('BODHI_TARGET', '').strip()

# Scope validation
ALLOWED = [
    ipaddress.ip_network('192.168.0.0/24'),
    ipaddress.ip_network('100.64.0.0/10'),
    ipaddress.ip_network('91.99.61.195/32'),
    ipaddress.ip_network('135.181.80.99/32'),
]

def in_scope(t):
    try:
        addr = ipaddress.ip_address(t.split('/')[0])
        return any(addr in net for net in ALLOWED)
    except ValueError:
        return False

if not in_scope(TARGET):
    print('SCOPE_VIOLATION')
    exit(1)

cmds = ';'.join([
    'use auxiliary/scanner/portscan/tcp',
    f'set RHOSTS {TARGET}',
    'set PORTS 21,22,25,53,80,443,3000,3306,5432,5900,6379,8080,8443,8888,9200,27017',
    'set THREADS 20',
    'set TIMEOUT 500',
    'run',
    'exit'
])

r = subprocess.run(
    ['msfconsole', '-q', '-x', cmds],
    capture_output=True, text=True, timeout=120
)
# Filter to just open port lines
lines = [l for l in r.stdout.splitlines() if 'open' in l.lower() or 'error' in l.lower() or 'fail' in l.lower()]
print('\n'.join(lines[-50:]) or 'No open ports found.')
"
```

Reply format:
```
Scan: 91.99.61.195
Open: 22/tcp (SSH), 80/tcp (HTTP), 443/tcp (HTTPS)
Done.
```

---

## On `/msf vuln <target>`

Vulnerability scan. Runs a curated set of safe auxiliary scanner modules. No exploitation — detection only.

Scope-validate `<target>` first.

```bash
BODHI_TARGET='<target>' python3 -c "
import subprocess, os, ipaddress, json
from datetime import datetime

TARGET = os.environ.get('BODHI_TARGET', '').strip()

ALLOWED = [
    ipaddress.ip_network('192.168.0.0/24'),
    ipaddress.ip_network('100.64.0.0/10'),
    ipaddress.ip_network('91.99.61.195/32'),
    ipaddress.ip_network('135.181.80.99/32'),
]

def in_scope(t):
    try:
        addr = ipaddress.ip_address(t.split('/')[0])
        return any(addr in net for net in ALLOWED)
    except ValueError:
        return False

if not in_scope(TARGET):
    print('SCOPE_VIOLATION')
    exit(1)

# Safe detection-only modules
modules = [
    ('auxiliary/scanner/ssh/ssh_version',         {'RHOSTS': TARGET, 'THREADS': '5'}),
    ('auxiliary/scanner/http/http_version',        {'RHOSTS': TARGET, 'THREADS': '5'}),
    ('auxiliary/scanner/http/dir_listing',         {'RHOSTS': TARGET, 'THREADS': '5'}),
    ('auxiliary/scanner/ssl/openssl_heartbleed',   {'RHOSTS': TARGET, 'THREADS': '5'}),
    ('auxiliary/scanner/http/tomcat_mgr_login',    {'RHOSTS': TARGET, 'THREADS': '5', 'BLANK_PASSWORDS': 'true', 'USER_AS_PASS': 'false'}),
]

all_output = []
for module, opts in modules:
    cmds_parts = [f'use {module}']
    for k, v in opts.items():
        cmds_parts.append(f'set {k} {v}')
    cmds_parts += ['run', 'exit']
    r = subprocess.run(
        ['msfconsole', '-q', '-x', ';'.join(cmds_parts)],
        capture_output=True, text=True, timeout=60
    )
    lines = [l for l in r.stdout.splitlines()
             if any(kw in l.lower() for kw in ['version', 'vuln', 'open', 'found', 'detected', 'error'])]
    if lines:
        all_output.append(f'[{module.split(\"/\")[-1]}]')
        all_output.extend(lines[-10:])

# Log to audit file
log_entry = json.dumps({
    'ts': datetime.utcnow().isoformat(),
    'action': 'vuln_scan',
    'target': TARGET,
    'findings': len(all_output)
})
import pathlib
log = pathlib.Path.home() / '.openclaw' / 'msf-audit.jsonl'
with open(log, 'a') as f:
    f.write(log_entry + '\n')

print('\n'.join(all_output) or 'No notable findings.')
"
```

Reply format:
```
Vuln scan: 91.99.61.195
[ssh_version] SSH version detected: OpenSSH_8.9
[http_version] Apache/2.4.54
No critical findings.
Logged to msf-audit.jsonl
```

---

## On `/msf modules <search>`

Search available Metasploit modules.

```bash
BODHI_SEARCH='<search>' python3 -c "
import subprocess, os

query = os.environ.get('BODHI_SEARCH', '').strip()
if not query or len(query) > 80:
    print('INVALID_ARG')
    exit()

# Sanitize: alphanumeric + slash + underscore + dash only
import re
if not re.match(r'^[\w\s/\-]+$', query):
    print('INVALID_CHARS')
    exit()

r = subprocess.run(
    ['msfconsole', '-q', '-x', f'search {query}; exit'],
    capture_output=True, text=True, timeout=60
)
# Return first 30 result lines
lines = [l for l in r.stdout.splitlines() if '   ' in l and ('auxiliary' in l or 'exploit' in l or 'post' in l)]
print('\n'.join(lines[:30]) or 'No modules found.')
"
```

---

## On `/msf run <module> on <target> [key=value ...]`

Run a specific Metasploit module. Requires explicit confirmation for exploit/* modules.

**Example:** `/msf run auxiliary/scanner/ssh/ssh_login on 192.168.0.1 THREADS=5`

Parse the message to extract:
- `module` — the module path
- `target` — the RHOSTS value
- `options` — any `key=value` pairs after the target

**If module starts with `exploit/`:** do NOT run. Reply:
```
exploit/ modules execute payloads and open sessions.
To use: /msf exploit <module> on <target> — requires double confirm.
```

**For auxiliary/* and post/* modules only:**

Scope-validate `<target>` first. Then:

```bash
BODHI_MODULE='<module>' BODHI_TARGET='<target>' BODHI_OPTS='<options>' python3 -c "
import subprocess, os, ipaddress, re, json
from datetime import datetime

MODULE = os.environ.get('BODHI_MODULE', '').strip()
TARGET = os.environ.get('BODHI_TARGET', '').strip()
OPTS_RAW = os.environ.get('BODHI_OPTS', '').strip()

# Reject exploit modules at this path
if MODULE.startswith('exploit/'):
    print('USE_EXPLOIT_PATH')
    exit(1)

# Module path: only alphanum, slash, underscore
if not re.match(r'^[\w/]+$', MODULE):
    print('INVALID_MODULE')
    exit(1)

# Scope check
ALLOWED = [
    ipaddress.ip_network('192.168.0.0/24'),
    ipaddress.ip_network('100.64.0.0/10'),
    ipaddress.ip_network('91.99.61.195/32'),
    ipaddress.ip_network('135.181.80.99/32'),
]
try:
    addr = ipaddress.ip_address(TARGET.split('/')[0])
    if not any(addr in net for net in ALLOWED):
        print('SCOPE_VIOLATION')
        exit(1)
except ValueError:
    print('INVALID_TARGET')
    exit(1)

# Parse options (key=value pairs)
opts = {}
for pair in OPTS_RAW.split():
    if '=' in pair:
        k, v = pair.split('=', 1)
        # Only alphanum keys, values limited to safe chars
        if re.match(r'^\w+$', k) and re.match(r'^[\w.,/:\-]+$', v):
            opts[k] = v

cmds_parts = [f'use {MODULE}', f'set RHOSTS {TARGET}']
for k, v in opts.items():
    cmds_parts.append(f'set {k} {v}')
cmds_parts += ['run', 'exit']

r = subprocess.run(
    ['msfconsole', '-q', '-x', ';'.join(cmds_parts)],
    capture_output=True, text=True, timeout=180
)

# Audit log
log_entry = json.dumps({
    'ts': datetime.utcnow().isoformat(),
    'action': 'module_run',
    'module': MODULE,
    'target': TARGET,
    'opts': opts
})
import pathlib
log = pathlib.Path.home() / '.openclaw' / 'msf-audit.jsonl'
with open(log, 'a') as f:
    f.write(log_entry + '\n')

output = r.stdout[-2000:] or r.stderr[-500:] or 'No output.'
print(output)
"
```

---

## On `/msf exploit <module> on <target> [options]`

**Stage 1 — first call:** Show what the module does, set options, ask for confirmation.

Reply:
```
⚠️ EXPLOIT MODULE — REQUIRES CONFIRM

Module:  <module>
Target:  <target>
Options: <parsed key=value list>

This will attempt active exploitation. Only authorized on your own infrastructure.

Reply: /msf exploit confirm <same exact command>
```

Do NOT execute yet.

**Stage 2 — `/msf exploit confirm <module> on <target> [options]`:**

Scope-validate target. Then execute with a 5-minute timeout:

```bash
BODHI_MODULE='<module>' BODHI_TARGET='<target>' BODHI_OPTS='<options>' python3 -c "
import subprocess, os, ipaddress, re, json
from datetime import datetime

MODULE = os.environ.get('BODHI_MODULE', '').strip()
TARGET = os.environ.get('BODHI_TARGET', '').strip()
OPTS_RAW = os.environ.get('BODHI_OPTS', '').strip()

# Scope check
ALLOWED = [
    ipaddress.ip_network('192.168.0.0/24'),
    ipaddress.ip_network('100.64.0.0/10'),
    ipaddress.ip_network('91.99.61.195/32'),
    ipaddress.ip_network('135.181.80.99/32'),
]
try:
    addr = ipaddress.ip_address(TARGET.split('/')[0])
    if not any(addr in net for net in ALLOWED):
        print('SCOPE_VIOLATION')
        exit(1)
except ValueError:
    print('INVALID_TARGET')
    exit(1)

# Module path validation
if not re.match(r'^[\w/]+$', MODULE):
    print('INVALID_MODULE')
    exit(1)

# Parse options
opts = {}
for pair in OPTS_RAW.split():
    if '=' in pair:
        k, v = pair.split('=', 1)
        if re.match(r'^\w+$', k) and re.match(r'^[\w.,/:\-]+$', v):
            opts[k] = v

cmds_parts = [
    f'use {MODULE}',
    f'set RHOSTS {TARGET}',
    'set LHOST 192.168.0.247',   # always bodhi1 as handler
]
for k, v in opts.items():
    cmds_parts.append(f'set {k} {v}')
cmds_parts += ['run', 'sessions -l', 'exit']

r = subprocess.run(
    ['msfconsole', '-q', '-x', ';'.join(cmds_parts)],
    capture_output=True, text=True, timeout=300
)

# Audit log (mandatory)
log_entry = json.dumps({
    'ts': datetime.utcnow().isoformat(),
    'action': 'exploit_confirmed',
    'module': MODULE,
    'target': TARGET,
    'opts': opts
})
import pathlib
log = pathlib.Path.home() / '.openclaw' / 'msf-audit.jsonl'
with open(log, 'a') as f:
    f.write(log_entry + '\n')

print(r.stdout[-2000:] or r.stderr[-500:] or 'No output.')
"
```

---

## On `/msf sessions`

List active Metasploit sessions (open shells/meterpreter).

```bash
python3 -c "
import subprocess
r = subprocess.run(
    ['msfconsole', '-q', '-x', 'sessions -l; exit'],
    capture_output=True, text=True, timeout=30
)
lines = [l for l in r.stdout.splitlines() if l.strip() and 'sessions' not in l.lower()]
print('\n'.join(lines[-20:]) or 'No active sessions.')
"
```

---

## On `/msf kill`

Terminate all active Metasploit sessions.

```bash
python3 -c "
import subprocess
r = subprocess.run(
    ['msfconsole', '-q', '-x', 'sessions -K; exit'],
    capture_output=True, text=True, timeout=30
)
print('All sessions terminated.')
"
```

---

## On `/msf log`

Show recent audit log entries.

```bash
python3 -c "
import pathlib, json
log = pathlib.Path.home() / '.openclaw' / 'msf-audit.jsonl'
if not log.exists():
    print('No audit log yet.')
    exit()
lines = log.read_text().strip().splitlines()
for line in lines[-10:]:
    try:
        e = json.loads(line)
        print(f\"{e['ts'][:16]}  {e['action']:20}  {e.get('module','')[:30]}  {e.get('target','')}\")
    except Exception:
        pass
"
```

---

## Rules

- **Scope is absolute.** Any target not in the allowed list: refuse, no exceptions, no overrides.
- **exploit/ modules always require two-step confirmation.** Never run on first call.
- **Every run is logged** to `~/.openclaw/msf-audit.jsonl`. No exceptions.
- **LHOST is always bodhi1** (`192.168.0.247`) for any payload/handler — never an external IP.
- **Output is truncated to 2000 chars.** Raw logs are on bodhi1 if more detail is needed.
- **Timeout: 120s** for scans, **180s** for module runs, **300s** for exploit attempts.
- **If msfconsole is not installed:** reply with install instructions, do not attempt to install automatically.
- **If scope violation:** log the attempt to `msf-audit.jsonl`, reply `Out of scope.`, stop.
- **Never run msfcrawl, db_autopwn, or msfvenom** via this skill — those are manual-only operations.
- If SSH is used to reach bodhi1 from another host: use `ssh bodhi1 "python3 -c '...'"` with the inline script.
