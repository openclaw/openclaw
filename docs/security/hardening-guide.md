# Security Hardening Guide

A practical guide to securing your OpenClaw configuration. These recommendations are based on real-world analysis of publicly committed OpenClaw configurations on GitHub.

## Quick Check

Run a security audit of your configuration in under 1 second:

```bash
npx clawhatch scan
```

This checks 128 security issues across 10 categories, entirely locally — nothing leaves your machine.

---

## 1. Never Commit Credentials

**Risk:** Hardcoded API keys, bot tokens, and passwords in `openclaw.json` are the most common security issue we see in public repositories.

**Fix:** Use environment variable references instead of plaintext values:

```json
// ❌ Bad — credentials in plaintext
{
  "providers": {
    "anthropic": {
      "apiKey": "sk-ant-api03-actual-key-here"
    }
  }
}

// ✅ Good — environment variable reference
{
  "providers": {
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}"
    }
  }
}
```

Store the actual values in a `.env` file:

```bash
# .env (add to .gitignore!)
ANTHROPIC_API_KEY=sk-ant-api03-...
OPENAI_API_KEY=sk-proj-...
TELEGRAM_BOT_TOKEN=123456:ABC-...
```

### Add to .gitignore

```gitignore
# OpenClaw security
openclaw.json
.env
.env.*
*.jsonl
sessions/
```

> **⚠️ Known Issue ([#9627](https://github.com/openclaw/openclaw/issues/9627)):** Running `openclaw update`, `openclaw doctor`, or `openclaw configure` may resolve `${...}` environment variable references and write the actual values back to `openclaw.json`. Check your config file after running these commands and restore `${...}` syntax if needed.

---

## 2. Enable Sandbox Isolation

**Risk:** Without sandbox configuration, the AI agent executes commands with the same permissions as the user who launched OpenClaw — unrestricted shell, file, and network access.

**Fix:** Set sandbox mode in your config:

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main"
      }
    }
  }
}
```

Available modes:
- `"non-main"` — Sandbox all sessions except the main session (recommended minimum)
- `"always"` — Sandbox all sessions including main (maximum isolation)

---

## 3. Configure DM Allowlists

**Risk:** Without a DM allowlist, anyone who can message your bot on Telegram, Discord, or WhatsApp can potentially issue commands to it.

**Fix:** Restrict who can send direct messages to your agent:

```json
{
  "identity": {
    "ownerNumbers": ["+15555551234"],
    "dmAllowlist": [
      "your-telegram-user-id",
      "your-discord-user-id",
      "+15555551234"
    ]
  }
}
```

Without an allowlist, you're relying on the agent's prompt engineering to reject malicious requests. That is not a security boundary.

---

## 4. Bind Gateway to Localhost

**Risk:** Binding the gateway to `0.0.0.0` exposes the agent's control API to your entire local network (or the internet, if port-forwarded).

**Fix:**

```json
{
  "gateway": {
    "bind": "127.0.0.1:18789"
  }
}
```

If you need remote access, use SSH tunneling or a reverse proxy with authentication rather than exposing the gateway directly.

---

## 5. Use Strong Auth Tokens

**Risk:** Weak, default, or missing gateway auth tokens allow anyone with network access to control your agent.

**Fix:** Generate a cryptographically random token:

```bash
# Generate a 32-byte random hex token
openssl rand -hex 32
```

```json
{
  "gateway": {
    "authToken": "your-64-character-random-hex-token"
  }
}
```

Avoid common tokens like `test`, `password`, `changeme`, or short tokens that can be brute-forced.

---

## 6. Review Tool Permissions

**Risk:** Agents with elevated tool access (browser control, node pairing, file system access) have a larger attack surface.

**Fix:** Only enable the tools your agent actually needs. Review `agents.defaults.sandbox` settings:

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main",
        "browser": {
          "allowHostControl": false
        }
      }
    }
  }
}
```

---

## 7. Check Your Git History

Even if your current config is clean, Git preserves everything:

```bash
# Check if openclaw.json was ever committed
git log --all --full-history -- openclaw.json

# View a specific commit's version
git show <commit-hash>:openclaw.json
```

If credentials appear in your history:

1. **Rotate all exposed credentials immediately**
2. Use [BFG Repo-Cleaner](https://rtyley.github.io/bfg-repo-cleaner/) or `git filter-branch` to remove secrets from history
3. Force push the cleaned history
4. Consider any credentials that were ever committed as compromised

---

## Security Checklist

| Check | Status |
|-------|--------|
| No plaintext credentials in config | ☐ |
| Using `${ENV_VAR}` references for all secrets | ☐ |
| `openclaw.json` in `.gitignore` | ☐ |
| `.env` in `.gitignore` | ☐ |
| Sandbox mode set to `non-main` or `always` | ☐ |
| DM allowlist configured | ☐ |
| Gateway bound to `127.0.0.1` | ☐ |
| Strong auth token set | ☐ |
| Git history clean of credentials | ☐ |
| No unnecessary elevated tool permissions | ☐ |

---

## Automated Scanning

For automated security auditing, [Clawhatch](https://clawhatch.com) provides a comprehensive scanner:

```bash
# Run a full security audit
npx clawhatch scan

# Auto-fix safe issues
npx clawhatch scan --fix

# Share anonymized results with the community threat feed
npx clawhatch scan --share
```

128 checks across 10 categories: secrets, identity & access, network exposure, sandbox configuration, data protection, model security, tool permissions, skills & plugins, operational security, and cloud sync.

---

## Further Reading

- [OpenClaw Threat Model](/security/threat-model-atlas)
- [Trust & Vulnerability Reporting](https://trust.openclaw.ai)
- [State of AI Agent Security 2026](https://clawhatch.com/blog/state-of-ai-agent-security-2026) — Public audit of GitHub-hosted OpenClaw configurations
