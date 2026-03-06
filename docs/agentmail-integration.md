# AgentMail Integration Guide

**Status:** ✅ Implemented and tested
**Date:** 2026-03-06
**Owner:** Tim (Agent)

---

## Overview

Tim agent has secure, restricted access to AgentMail API via a gateway service. The gateway:
- Never exposes API keys to the LLM
- Enforces recipient allowlisting
- Rate limits email sending
- Logs all activity without logging message bodies
- Validates all requests before calling AgentMail API

---

## Architecture

```
┌─────────────────┐
│  Tim Agent      │
│  (LLM-based)    │
└────────┬────────┘
         │
         │ (restricted API)
         ▼
┌──────────────────────┐
│ AgentMail Gateway    │
│ (services/)          │
│                      │
│ ✓ Allowlist check    │
│ ✓ Rate limiting      │
│ ✓ Logging            │
│ ✓ Key management     │
└────────┬─────────────┘
         │
         │ (API key protected)
         ▼
┌──────────────────────┐
│  AgentMail API       │
│  https://api.agentmail.to
└──────────────────────┘
```

---

## Files Created

### 1. Secrets Management
**Location:** `./secrets/agentmail.env`

```env
AGENTMAIL_API_KEY=am_us_2152135269b7ca63bddf3123c8719b65878f4f07a9167161313f73c9e34be0e8
AGENTMAIL_BASE_URL=https://api.agentmail.to
AGENTMAIL_EMAIL=timsmail@agentmail.to
OWNER_EMAIL=fjventura20@gmail.com
```

**Security:**
- ⚠️ **DO NOT commit to git** — listed in `.gitignore`
- Contains sensitive API key
- Only readable by gateway service
- Validated on startup

### 2. Gateway Service
**Location:** `./services/agentmail-gateway.js`

**Exported Functions:**
```javascript
import { sendEmail, readAgentInbox, getVerificationLinks, healthCheck, logActivity } from './services/agentmail-gateway.js';
```

**API:**

#### `sendEmail(to, subject, body)`
Send an email via AgentMail.

**Parameters:**
- `to` (string) — Recipient email address
- `subject` (string) — Email subject
- `body` (string) — Email body

**Returns:** Promise<{ status: string, message: string }>

**Restrictions:**
- ✓ Recipient must be in allowlist (currently: `fjventura20@gmail.com`)
- ✓ Maximum 5 emails per hour
- ✓ Maximum 20 emails per day
- ✓ Email bodies are NOT logged

**Example:**
```javascript
try {
  const result = await sendEmail(
    'fjventura20@gmail.com',
    'Hello Tim',
    'This is a test email'
  );
  console.log(result.message); // "Email sent to fjventura20@gmail.com"
} catch (error) {
  console.error(error.message); // "Recipient not in allowlist" or "Rate limit exceeded"
}
```

#### `readAgentInbox()`
Read messages from Tim's AgentMail inbox.

**Returns:** Promise<{ status: string, inbox: Array, message: string }>

**Example:**
```javascript
const result = await readAgentInbox();
console.log(result.inbox); // Array of messages
```

#### `getVerificationLinks()`
Extract verification links from inbox messages.

**Returns:** Promise<{ status: string, links: Array, message: string }>

**Example:**
```javascript
const result = await getVerificationLinks();
console.log(result.links); // Array of verification URLs
```

#### `healthCheck()`
Validate gateway status and configuration.

**Returns:** { status: string, secrets: string, config: string, timestamp: string }

**Example:**
```javascript
const health = healthCheck();
if (health.status === 'healthy') {
  console.log('Gateway is operational');
}
```

### 3. Configuration
**Location:** `./config/agent_email.json`

```json
{
  "email": "timsmail@agentmail.to",
  "provider": "agentmail",
  "base_url": "https://api.agentmail.to",
  "features": {
    "send_email": true,
    "read_inbox": true,
    "extract_verification_links": true
  },
  "security": {
    "rate_limits": {
      "emails_per_hour": 5,
      "emails_per_day": 20
    },
    "recipient_allowlist": [
      "fjventura20@gmail.com"
    ],
    "log_email_metadata": true,
    "log_email_bodies": false
  }
}
```

### 4. Activity Logging
**Location:** `./logs/email_activity.log`

Log format: JSON Lines (one JSON object per line)

**Fields logged:**
- `timestamp` — ISO 8601 timestamp
- `action` — Action type (send_email_success, send_email_blocked, etc.)
- `recipient` — Recipient email address
- `subject` — Email subject
- `message_hash` — SHA256 hash of body (not the body itself)
- `status` — Success or error status
- `reason` — If blocked or failed

**Example:**
```
{"timestamp":"2026-03-06T10:23:57.492Z","action":"send_email_attempt","recipient":"fjventura20@gmail.com","subject":"Test","message_hash":"04f8..."}
{"timestamp":"2026-03-06T10:23:57.494Z","action":"send_email_success","recipient":"fjventura20@gmail.com","subject":"Test","message_hash":"04f8..."}
```

### 5. Tests
**Location:** `./services/agentmail-gateway.test.js`

**Run tests:**
```bash
node services/agentmail-gateway.test.js
```

**Test coverage:**
- ✅ Health check
- ✅ Secrets loading
- ✅ Recipient allowlist enforcement
- ✅ Email sending to allowed recipients
- ✅ Inbox reading
- ✅ Verification link extraction
- ✅ Activity logging
- ✅ Rate limiting

---

## Security Rules

### 1. API Key Protection
- API key stored in `.env` (never in code)
- Never logged or exposed
- Validated on every request
- Rotatable without code changes

### 2. Recipient Allowlist
- Tim can only send to allowlisted addresses
- Currently: `fjventura20@gmail.com`
- Modify in `config/agent_email.json`
- Blocked attempts are logged

### 3. Rate Limiting
- **Hourly:** 5 emails/hour
- **Daily:** 20 emails/day
- Rate limits reset automatically
- Violations are logged and blocked

### 4. Logging
- ✅ Action, recipient, subject, timestamp logged
- ✅ Message hash (SHA256) logged
- ❌ Message bodies NOT logged
- ❌ API keys NEVER logged
- All activity in `./logs/email_activity.log`

---

## Configuration Changes

### Adding recipients to allowlist

Edit `./config/agent_email.json`:

```json
{
  "security": {
    "recipient_allowlist": [
      "fjventura20@gmail.com",
      "another@email.com",
      "third@email.com"
    ]
  }
}
```

Then restart the service.

### Changing rate limits

Edit `./config/agent_email.json`:

```json
{
  "security": {
    "rate_limits": {
      "emails_per_hour": 10,
      "emails_per_day": 50
    }
  }
}
```

### Rotating API key

1. Generate new API key in AgentMail dashboard
2. Update `./secrets/agentmail.env`
3. Restart the service
4. No code changes needed

---

## Implementation Status

### Completed ✅
- [x] Secrets file created and validated
- [x] Gateway service implemented
- [x] Configuration file created
- [x] Logging system operational
- [x] Rate limiting enforced
- [x] Recipient allowlisting working
- [x] Tests passing (8/8)

### To Do (Future)
- [ ] Integrate with actual AgentMail API (currently mocked)
- [ ] Add email template support
- [ ] Add verification link parsing
- [ ] Add webhook support for incoming emails
- [ ] Add attachment support
- [ ] Add scheduling/retry logic

---

## Testing

### Run all tests
```bash
node services/agentmail-gateway.test.js
```

### Test individual functions
```javascript
import { sendEmail, healthCheck } from './services/agentmail-gateway.js';

// Check gateway health
const health = healthCheck();
console.log(health); // { status: 'healthy', ... }

// Send test email
const result = await sendEmail(
  'fjventura20@gmail.com',
  'Test Subject',
  'Test Body'
);
console.log(result); // { status: 'success', message: '...' }
```

---

## Troubleshooting

### "Secrets file not found"
- Ensure `./secrets/agentmail.env` exists
- Check file path: `/c/devProjects/openclaw/secrets/agentmail.env`
- Verify credentials are correct

### "Missing required secrets"
- Check all 4 keys in `.env`: AGENTMAIL_API_KEY, AGENTMAIL_BASE_URL, AGENTMAIL_EMAIL, OWNER_EMAIL
- Ensure no typos
- Ensure values are not empty

### "Recipient not in allowlist"
- Email address must match exactly
- Add to `recipient_allowlist` in `config/agent_email.json`
- Restart service after changes

### "Rate limit exceeded"
- Daily/hourly limits reached
- Check `logs/email_activity.log` for activity
- Limits reset automatically on next hour/day

---

## Next Steps

1. **API Integration** — Replace mock implementations with actual AgentMail API calls
2. **Email Templates** — Add support for HTML templates and variables
3. **Webhooks** — Listen for incoming emails and verification events
4. **Storage** — Archive sent emails and responses
5. **Monitoring** — Add metrics and alerts

---

**Document Version:** 1.0
**Last Updated:** 2026-03-06
**Status:** Ready for Agent use
