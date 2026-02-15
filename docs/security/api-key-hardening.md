# Securing API Keys from Agent Access

This guide shows how to protect your API credentials from being exposed by your OpenClaw agent, even under prompt injection attacks.

## The Problem

OpenClaw agents have filesystem access to read configuration files, including `.env` files containing API keys. While you can instruct the agent not to display these values, this relies on "discipline" — the agent choosing to follow rules.

**This is not secure because:**
1. Agents may accidentally display keys while debugging
2. Prompt injection attacks could trick the agent into revealing secrets
3. Rules can be bypassed; permissions cannot

## The Solution: User Isolation

Create a separate Linux user that:
- Owns your secrets (`.env` file)
- Owns wrapper scripts that use those secrets
- Cannot be accessed by your main user (or the agent)

Your agent gets **limited sudo access** to run specific scripts as this user, but cannot read the secrets themselves.

## Setup Guide

### Step 1: Create the Secrets User

```bash
# Create user with home directory
sudo useradd -m -s /bin/bash secretsuser

# Lock down their home directory
sudo chmod 700 /home/secretsuser
```

### Step 2: Create Scripts Directory

```bash
sudo -u secretsuser mkdir -p /home/secretsuser/scripts
```

### Step 3: Create the Secrets File

```bash
sudo -u secretsuser nano /home/secretsuser/.env
```

Add your API keys:
```
MY_API_KEY=your_key_here
MY_API_SECRET=your_secret_here
```

Lock it down:
```bash
sudo -u secretsuser chmod 600 /home/secretsuser/.env
```

### Step 4: Create Wrapper Scripts

Example: Generic API script that accepts method, endpoint, and data:

```bash
sudo -u secretsuser tee /home/secretsuser/scripts/myapi.sh << 'ENDSCRIPT'
#!/bin/bash
set -euo pipefail
source /home/secretsuser/.env

METHOD="${1:-GET}"
ENDPOINT="${2:-}"
DATA="${3:-}"

if [ -n "$DATA" ]; then
  curl -s -X "$METHOD" \
    -H "Authorization: Bearer ${MY_API_KEY}" \
    -H "Content-Type: application/json" \
    "https://api.example.com/${ENDPOINT}" \
    -d "$DATA"
else
  curl -s -X "$METHOD" \
    -H "Authorization: Bearer ${MY_API_KEY}" \
    -H "Accept: application/json" \
    "https://api.example.com/${ENDPOINT}"
fi
ENDSCRIPT
```

Make it executable:
```bash
sudo -u secretsuser chmod 700 /home/secretsuser/scripts/myapi.sh
```

### Step 5: Configure Sudo Access

```bash
sudo visudo -f /etc/sudoers.d/openclaw-secrets
```

Add a line for each script (replace `youruser` with your actual username):
```
youruser ALL=(secretsuser) NOPASSWD: /home/secretsuser/scripts/myapi.sh
```

**Important security notes:**
- Only whitelist the exact script paths — never add `/bin/bash`, `/bin/sh`, or other interpreters
- The whitelist is strict: `sudo -u secretsuser /bin/bash /path/to/script` will be denied because `/bin/bash` isn't whitelisted
- Each script must be listed separately; wildcards like `/home/secretsuser/scripts/*` would allow creating new scripts to bypass security

### Step 6: Test It

As your normal user:
```bash
# This should work:
sudo -u secretsuser /home/secretsuser/scripts/myapi.sh GET "users/me"

# This should fail:
cat /home/secretsuser/.env
# Permission denied
```

## Security Analysis

### What the agent CAN do:
- Run whitelisted scripts via sudo
- Pass arguments to those scripts
- See the output (API responses)

### What the agent CANNOT do:
- Read `/home/secretsuser/.env` — Permission denied
- Read `/home/secretsuser/scripts/*` — Permission denied
- Run arbitrary commands as secretsuser — Not in sudoers whitelist
- Modify the scripts — Permission denied

### Attack Vectors Addressed:

| Attack | Mitigated By |
|--------|--------------|
| Agent reads .env directly | File permissions (600, wrong user) |
| Agent reads script source | Directory permissions (700) |
| Prompt injection to leak keys | Cannot read what it cannot access |
| Agent runs arbitrary sudo | Whitelist only allows specific scripts |
| Interpreter bypass (`sudo -u secretsuser /bin/bash script`) | Only exact paths are whitelisted; `/bin/bash` not allowed |
| Argument injection | Proper quoting in scripts (see below) |

## Writing Secure Scripts

### DO: Quote all variables
```bash
# Good
curl -d "text=${TEXT}" ...
```

### DON'T: Use eval or unquoted expansion
```bash
# Bad - allows injection
eval "$1"
curl -d text=$TEXT ...
```

### DO: Validate inputs
```bash
# Good
if [[ ! "$1" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Invalid input"
  exit 1
fi
```

### DON'T: Echo raw API responses with potential secrets
```bash
# Bad - might leak tokens in error messages
curl ... 2>&1

# Good - only show what you intend
RESPONSE=$(curl -s ...)
echo "$RESPONSE" | jq '.data'
```

## Common API Patterns

### Basic Auth (e.g., Follow Up Boss)
```bash
curl -s -u "${API_KEY}:" "https://api.example.com/endpoint"
```

### Bearer Token
```bash
curl -s -H "Authorization: Bearer ${API_KEY}" "https://api.example.com/endpoint"
```

### OAuth 1.0 (e.g., Twitter/X)
Use a library like `twurl` or Python's `tweepy` inside the script.

## Removing Old Keys

After setting this up, remove keys from locations the agent can access:

```bash
# Remove from old .env
rm ~/.openclaw/.env
# Or edit to remove sensitive values
nano ~/.openclaw/.env
```

## Troubleshooting

**"Permission denied" when agent runs script:**
- Check sudoers config: `sudo cat /etc/sudoers.d/openclaw-secrets`
- Ensure exact path matches

**"unbound variable" error:**
- Key not in `.env` or misspelled
- Check with: `sudo -u secretsuser cat /home/secretsuser/.env | sed 's/=.*/=***/'`

**Script works manually but not via sudo:**
- Check script permissions: `sudo -u secretsuser ls -la /home/secretsuser/scripts/`
- Should be `-rwx------` (700)

## Conclusion

This approach provides real security through Linux permissions — not just rules the agent might break. Until OpenClaw implements native secret masking, this is the most robust protection available.

See also: [OpenClaw Feature Request #10659](https://github.com/openclaw/openclaw/issues/10659)
