# Apertis OpenClaw Provider — Integration Guide

**Date:** 2026-03-16  
**Version:** 1.0.0  
**Audience:** DevOps, Platform Engineers, System Administrators

---

## Quick Start (5 minutes)

### Step 1: Get API Key

1. Go to https://console.apertis.ai
2. Navigate to **API Keys**
3. Click **Create New Key**
4. Copy the key (format: `sk-proj-...`)

### Step 2: Set Environment Variable

```bash
export APERTIS_API_KEY="sk-proj-your-key-here"
```

### Step 3: Verify Connectivity

```bash
curl -H "Authorization: Bearer $APERTIS_API_KEY" \
  https://api.apertis.ai/v1/models
```

Expected response:
```json
{
  "object": "list",
  "data": [
    {"id": "gpt-5.2", "object": "model", ...},
    {"id": "gpt-4.1", "object": "model", ...},
    ...
  ]
}
```

### Step 4: Add to OpenClaw

Copy `provider-config.json` to OpenClaw config:

```bash
cp provider-config.json ~/.openclaw/config/providers.json
```

### Step 5: Restart Gateway

```bash
openclaw gateway restart
```

### Step 6: Test

```bash
openclaw model list --provider apertis
```

Expected output:
```
Provider: apertis
├── gpt-5.2 (Premium, Reasoning)
├── gpt-4.1 (Standard, Vision)
├── gpt-4-turbo (Standard, Vision)
└── gpt-3.5-turbo (Budget, Fast)
```

---

## Detailed Setup

### Prerequisites

- OpenClaw v2.8.0+
- Node.js v20+
- Valid Apertis API key
- Network access to `api.apertis.ai`

### Installation Steps

#### 1. Obtain Apertis API Key

**Option A: Web Console**
```
1. Visit https://console.apertis.ai
2. Sign in with your account
3. Go to Settings → API Keys
4. Click "Create New Key"
5. Select scope: "chat.completions", "models.list"
6. Copy the key
```

**Option B: CLI**
```bash
apertis auth login
apertis api-keys create --name "OpenClaw Integration"
```

#### 2. Configure OpenClaw

**File:** `~/.openclaw/config/providers.json`

```json
{
  "models": {
    "providers": {
      "apertis": {
        "type": "openai-compatible",
        "baseUrl": "https://api.apertis.ai/v1",
        "apiKey": "${APERTIS_API_KEY}",
        "api": "openai-completions",
        "auth": {
          "type": "bearer",
          "headerName": "Authorization",
          "tokenPrefix": "Bearer"
        },
        "models": [
          {
            "id": "gpt-5.2",
            "name": "GPT-5.2 (Reasoning)",
            "provider": "apertis",
            "enabled": true,
            "capabilities": {
              "reasoning": true,
              "vision": true,
              "streaming": true,
              "thinking": true
            },
            "limits": {
              "contextWindow": 200000,
              "maxTokens": 16000,
              "costPer1kInputTokens": 0.003,
              "costPer1kOutputTokens": 0.012
            }
          }
        ]
      }
    }
  }
}
```

#### 3. Set Environment Variables

```bash
# Add to ~/.zshrc or ~/.bashrc
export APERTIS_API_KEY="sk-proj-your-key-here"

# Reload shell
source ~/.zshrc
```

#### 4. Verify Configuration

```bash
# Check syntax
openclaw config validate

# Test connectivity
openclaw model test --provider apertis --model gpt-5.2
```

#### 5. Restart Gateway

```bash
openclaw gateway restart

# Monitor startup
openclaw gateway logs --follow
```

---

## Usage Examples

### Basic Chat Completion

```bash
openclaw chat --model gpt-5.2 --message "What is 2+2?"
```

Response:
```
Assistant: 2 + 2 = 4.
```

### Using Thinking Mode

```bash
openclaw chat \
  --model gpt-5.2 \
  --message "Solve: 2x + 5 = 13" \
  --thinking-budget 5000
```

Response:
```
Thinking: The user is asking me to solve a linear equation...
[reasoning process]

Answer: The solution is x = 4.
```

### Vision Request

```bash
openclaw chat \
  --model gpt-4.1 \
  --message "What's in this image?" \
  --image "https://example.com/photo.jpg"
```

### Streaming Response

```bash
openclaw chat \
  --model gpt-4.1 \
  --message "Write a poem about AI" \
  --stream
```

### Programmatic Usage (Node.js)

```javascript
const { OpenClaw } = require('openclaw');

const client = new OpenClaw({
  provider: 'apertis',
  apiKey: process.env.APERTIS_API_KEY
});

// Chat completion
const response = await client.chat.completions.create({
  model: 'gpt-5.2',
  messages: [
    { role: 'user', content: 'Hello!' }
  ]
});

console.log(response.choices[0].message.content);

// With thinking
const reasoning = await client.chat.completions.create({
  model: 'gpt-5.2',
  messages: [
    { role: 'user', content: 'Solve: 2x + 5 = 13' }
  ],
  thinking: {
    type: 'enabled',
    budget_tokens: 5000
  }
});

console.log('Thinking:', reasoning.choices[0].message.thinking.content);
console.log('Answer:', reasoning.choices[0].message.content);

// Streaming
const stream = await client.chat.completions.create({
  model: 'gpt-4.1',
  messages: [
    { role: 'user', content: 'Write a story' }
  ],
  stream: true
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0].delta.content || '');
}
```

### Programmatic Usage (Python)

```python
from openclaw import OpenClaw

client = OpenClaw(
    provider='apertis',
    api_key=os.environ['APERTIS_API_KEY']
)

# Chat completion
response = client.chat.completions.create(
    model='gpt-5.2',
    messages=[
        {'role': 'user', 'content': 'Hello!'}
    ]
)

print(response.choices[0].message.content)

# With thinking
reasoning = client.chat.completions.create(
    model='gpt-5.2',
    messages=[
        {'role': 'user', 'content': 'Solve: 2x + 5 = 13'}
    ],
    thinking={
        'type': 'enabled',
        'budget_tokens': 5000
    }
)

print('Thinking:', reasoning.choices[0].message.thinking.content)
print('Answer:', reasoning.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model='gpt-4.1',
    messages=[
        {'role': 'user', 'content': 'Write a story'}
    ],
    stream=True
)

for chunk in stream:
    print(chunk.choices[0].delta.content or '', end='')
```

---

## Troubleshooting

### Issue: "Invalid API Key"

**Symptom:**
```
Error: 401 Unauthorized - Invalid API key
```

**Solution:**
1. Verify key format: `sk-proj-...`
2. Check expiration: `apertis api-keys list`
3. Regenerate if needed: `apertis api-keys create`
4. Ensure env var is set: `echo $APERTIS_API_KEY`

### Issue: "Connection Refused"

**Symptom:**
```
Error: ECONNREFUSED - Cannot reach api.apertis.ai
```

**Solution:**
1. Check network: `ping api.apertis.ai`
2. Verify DNS: `nslookup api.apertis.ai`
3. Check firewall: `curl -v https://api.apertis.ai/v1/models`
4. Try VPN if behind corporate proxy

### Issue: "Model Not Found"

**Symptom:**
```
Error: 404 Not Found - Model gpt-5.2 not found
```

**Solution:**
1. List available models: `openclaw model list --provider apertis`
2. Check model ID spelling
3. Verify model is enabled in config
4. Refresh model cache: `openclaw model refresh --provider apertis`

### Issue: "Rate Limited"

**Symptom:**
```
Error: 429 Too Many Requests - Rate limit exceeded
```

**Solution:**
1. Check rate limit: `apertis account info`
2. Upgrade tier: https://console.apertis.ai/billing
3. Implement backoff: OpenClaw auto-retries with exponential backoff
4. Monitor usage: `openclaw dashboard --provider apertis`

### Issue: "Thinking Mode Not Supported"

**Symptom:**
```
Error: 400 Bad Request - Model does not support thinking
```

**Solution:**
1. Use gpt-5.2 (only model with thinking)
2. Check model capabilities: `openclaw model info gpt-5.2`
3. Verify thinking is enabled in config

### Issue: "Vision Not Supported"

**Symptom:**
```
Error: 400 Bad Request - Model does not support vision
```

**Solution:**
1. Use gpt-5.2, gpt-4.1, or gpt-4-turbo
2. Verify image URL is accessible
3. Check image format (JPEG, PNG, WebP, GIF)
4. Ensure image size < 20MB

---

## Monitoring & Observability

### View Usage Dashboard

```bash
openclaw dashboard --provider apertis
```

Displays:
- Total requests
- Token usage (input/output/thinking)
- Cost breakdown
- Error rate
- Latency metrics

### Export Usage Data

```bash
openclaw export usage \
  --provider apertis \
  --format csv \
  --output usage-report.csv
```

### Set Up Alerts

```bash
openclaw alerts create \
  --provider apertis \
  --condition "error_rate > 5%" \
  --action "email:ops@company.com"

openclaw alerts create \
  --provider apertis \
  --condition "cost_daily > $100" \
  --action "slack:#alerts"
```

### View Logs

```bash
# Real-time logs
openclaw logs --provider apertis --follow

# Filter by model
openclaw logs --provider apertis --model gpt-5.2

# Filter by error
openclaw logs --provider apertis --level error
```

---

## Security Best Practices

### 1. API Key Management

```bash
# ✅ DO: Use environment variables
export APERTIS_API_KEY="sk-proj-..."

# ❌ DON'T: Hardcode in config
# apiKey: "sk-proj-..." ← NEVER

# ✅ DO: Rotate keys regularly
apertis api-keys rotate --key-id old-key-id

# ✅ DO: Use separate keys per environment
export APERTIS_API_KEY_DEV="sk-proj-dev-..."
export APERTIS_API_KEY_PROD="sk-proj-prod-..."
```

### 2. Network Security

```bash
# ✅ DO: Use HTTPS only
baseUrl: "https://api.apertis.ai/v1"

# ✅ DO: Verify TLS certificates
curl --cacert /etc/ssl/certs/ca-bundle.crt \
  https://api.apertis.ai/v1/models

# ✅ DO: Use VPN for sensitive data
# Configure OpenClaw to route through VPN
```

### 3. Access Control

```bash
# ✅ DO: Limit API key scope
apertis api-keys create \
  --scope "chat.completions" \
  --scope "models.list"

# ✅ DO: Restrict by IP
apertis api-keys update key-id \
  --allowed-ips "203.0.113.0/24"

# ✅ DO: Set expiration
apertis api-keys create \
  --expires-in 90d
```

### 4. Audit & Compliance

```bash
# ✅ DO: Enable audit logging
openclaw config set \
  --audit-enabled true \
  --audit-log-path /var/log/openclaw-audit.log

# ✅ DO: Review access logs
tail -f /var/log/openclaw-audit.log | grep apertis

# ✅ DO: Export for compliance
openclaw export audit-log \
  --provider apertis \
  --start-date 2026-01-01 \
  --end-date 2026-03-16
```

---

## Performance Tuning

### Connection Pooling

```json
{
  "apertis": {
    "connectionPool": {
      "minSize": 10,
      "maxSize": 100,
      "idleTimeout": 30000,
      "maxLifetime": 600000
    }
  }
}
```

### Request Timeout

```json
{
  "apertis": {
    "timeout": {
      "connect": 5000,
      "request": 30000,
      "idle": 60000
    }
  }
}
```

### Caching

```json
{
  "apertis": {
    "cache": {
      "enabled": true,
      "ttl": 300000,
      "maxSize": 1000
    }
  }
}
```

---

## Maintenance

### Regular Tasks

**Daily:**
- Monitor error rate (target: < 1%)
- Check cost tracking

**Weekly:**
- Review usage trends
- Verify all models are responding

**Monthly:**
- Rotate API keys
- Update provider config if new models available
- Review security logs

### Upgrade Procedure

```bash
# Check for updates
openclaw provider check-updates apertis

# Backup current config
cp ~/.openclaw/config/providers.json \
   ~/.openclaw/config/providers.json.backup

# Update provider
openclaw provider update apertis

# Test
openclaw model test --provider apertis --model gpt-5.2

# Restart
openclaw gateway restart
```

### Rollback

```bash
# Restore backup
cp ~/.openclaw/config/providers.json.backup \
   ~/.openclaw/config/providers.json

# Restart
openclaw gateway restart
```

---

## Support & Resources

- **Documentation:** https://docs.apertis.ai
- **API Reference:** https://docs.apertis.ai/api/
- **Status Page:** https://status.apertis.ai
- **Support Email:** support@apertis.ai
- **Community:** https://community.apertis.ai

---

## Checklist

- [ ] API key obtained and verified
- [ ] Environment variable set
- [ ] Config file copied to `~/.openclaw/config/`
- [ ] Gateway restarted
- [ ] Models listed successfully
- [ ] Test chat completion works
- [ ] Monitoring dashboard accessible
- [ ] Alerts configured
- [ ] Security best practices implemented
- [ ] Team trained on usage

---

**Integration Complete!** 🎉

Your OpenClaw instance now has full access to Apertis models. Start using them immediately:

```bash
openclaw chat --model gpt-5.2 --message "Hello, Apertis!"
```
