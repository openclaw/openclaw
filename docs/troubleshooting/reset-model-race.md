---
summary: "Race conditions during model reset and reload operations"
title: "Reset-Model Race Conditions"
---

# Reset-Model Race Conditions

**Issue**: #20769

Race conditions occur when model configuration is reset or reloaded while requests are in-flight, leading to requests using partially initialized models, stale configurations, or missing providers.

## Understanding the Race

**Scenario:** Model reset during active request

```
Timeline:
T0: Request A starts with model "claude-opus-4-6"
T1: Admin runs: openclaw models reset
T2: Model registry cleared
T3: Request A tries to get model provider → undefined
T4: Request A crashes: "Cannot read property 'generate' of undefined"
T5: New model config loaded
```

**Result:** Request A fails despite being submitted before reset

## Race Conditions

### Race 1: In-Flight Request During Reset

**What happens:**

1. User sends chat request
2. Gateway accepts request, starts processing
3. Admin resets model configuration
4. Request tries to use now-undefined model provider
5. Request crashes

**Code path:**

```typescript
// Request thread
async function handleChatRequest(req) {
  const model = getModel(req.modelId); // ✅ Model exists
  // ... async operations ...
  // ⚠️ Model reset happens here
  await model.provider.generate(prompt); // ❌ provider is undefined
}
```

**Impact:** Failed requests, error responses to users

### Race 2: Concurrent Model Reload

**What happens:**

1. Admin runs `openclaw models reload`
2. Reload starts: clear registry, load new config
3. Before reload completes, another reload triggered
4. Both reloads race to populate registry
5. Registry ends up in inconsistent state

**Result:** Some models missing, duplicates, or wrong config

### Race 3: Provider Switch During Streaming

**What happens:**

1. User starts streaming response (Claude Opus)
2. Mid-stream, admin switches provider (Opus → Sonnet)
3. Next chunk request uses new provider
4. Response chunks don't match (different model)
5. Invalid response concatenation

**Result:** Corrupted streaming response, garbled text

### Race 4: Auth Refresh During Request

**What happens:**

1. Request starts with valid auth credentials
2. During request, credentials expire
3. Auto-refresh rotates credentials
4. Request completes with old credentials
5. Next request fails: "Invalid credentials"

**Result:** Intermittent auth failures despite valid credentials

## Detection

### Symptom 1: "Model provider undefined" errors

**User report:**

```
User: "Send message"
Agent: *Error: Cannot read property 'generate' of undefined*
User: "Try again"
Agent: *Works fine*
```

**In logs:**

```
[error] Model provider not found: claude-opus-4-6
[error] TypeError: Cannot read property 'generate' of undefined
  at ModelManager.generate (model-manager.ts:142)
```

**Pattern:** Sporadic, correlated with model resets

### Symptom 2: Inconsistent model behavior

**User report:**

```
User: "Continue our conversation"
Agent: *Response in different style*
User: "Why did you forget context?"
Agent: *Back to normal*
```

**In logs:**

```
[warn] Model switched mid-request: opus-4-6 → sonnet-4-5
[warn] Streaming response from mixed models
```

### Symptom 3: Registry corruption

**Admin report:**

```bash
$ openclaw models list
Error: Duplicate model ID: claude-opus-4-6
```

**In logs:**

```
[error] Model registry corruption detected
[error] Expected 5 models, found 7 entries
[warn]  Duplicate providers for model: opus
```

### Symptom 4: Auth failures after reload

**User report:**

```
User: "Send message"  # Works
Admin: *Reloads models*
User: "Send another"  # Fails: Invalid credentials
User: "Retry"          # Works
```

**In logs:**

```
[error] Authentication failed: credentials expired
[warn]  Auto-refresh in progress, request queued
[info]  Credentials refreshed successfully
```

## Root Causes

### Cause 1: No Request Tracking

**Issue:** Reset doesn't wait for in-flight requests

**Code:**

```typescript
// ❌ Immediate reset, no coordination
async resetModels() {
  this.modelRegistry.clear();
  await this.loadModels();
}
```

**Fix:**

```typescript
// ✅ Wait for in-flight requests to complete
private inflightRequests = new Set<Promise<any>>();

async resetModels() {
  // Stop accepting new requests
  this.accepting = false;

  // Wait for all in-flight requests
  await Promise.all(Array.from(this.inflightRequests));

  // Now safe to reset
  this.modelRegistry.clear();
  await this.loadModels();

  // Resume accepting requests
  this.accepting = true;
}
```

### Cause 2: No Reload Lock

**Issue:** Concurrent reloads race to populate registry

**Code:**

```typescript
// ❌ No lock, concurrent reloads interfere
async reloadModels() {
  const models = await loadModelConfig();
  this.modelRegistry.clear();
  models.forEach((m) => this.modelRegistry.set(m.id, m));
}
```

**Fix:**

```typescript
// ✅ Lock prevents concurrent reloads
private reloadLock = new AsyncLock();

async reloadModels() {
  await this.reloadLock.acquire("reload", async () => {
    const models = await loadModelConfig();
    this.modelRegistry.clear();
    models.forEach((m) => this.modelRegistry.set(m.id, m));
  });
}
```

### Cause 3: Provider Not Immutable

**Issue:** Provider object mutated during streaming

**Code:**

```typescript
// ❌ Same provider object mutated
class ProviderManager {
  private provider: Provider;

  async updateProvider(newConfig: Config) {
    this.provider = createProvider(newConfig); // ⚠️ Replaces mid-request
  }
}
```

**Fix:**

```typescript
// ✅ Copy-on-write, each request gets stable provider
class ProviderManager {
  private provider: Provider;

  async updateProvider(newConfig: Config) {
    const newProvider = createProvider(newConfig);
    // Keep old provider until all requests complete
    await this.waitForInflightRequests(this.provider);
    this.provider = newProvider;
  }
}
```

### Cause 4: No Auth Coordination

**Issue:** Credentials rotated while request using them

**Code:**

```typescript
// ❌ Immediate credential update
async refreshAuth() {
  const newCreds = await fetchNewCredentials();
  this.credentials = newCreds; // ⚠️ Replaces immediately
}
```

**Fix:**

```typescript
// ✅ Coordinate with in-flight requests
async refreshAuth() {
  const newCreds = await fetchNewCredentials();

  // Mark old credentials as deprecated
  this.credentials.deprecated = true;

  // Wait for requests to finish with old creds
  await this.waitForCredentialsUnused(this.credentials);

  // Now safe to replace
  this.credentials = newCreds;
}
```

## Workarounds

### Workaround 1: Scheduled Maintenance Window

**Approach:** Reset models during low-traffic periods

**Implementation:**

```bash
# Schedule model reload at 3 AM
0 3 * * * systemctl --user stop openclaw-gateway.service && \
          openclaw models reload && \
          systemctl --user start openclaw-gateway.service
```

**Pros:** No in-flight requests during reset

**Cons:** Downtime, not suitable for 24/7 deployments

### Workaround 2: Graceful Restart

**Approach:** Drain requests before reset

**Implementation:**

```bash
# Drain and restart
openclaw gateway drain --wait 30s
openclaw models reload
openclaw gateway resume
```

**Pros:** No failed requests

**Cons:** Requires drain support (not yet implemented)

### Workaround 3: Blue-Green Model Swap

**Approach:** Load new models alongside old, switch atomically

**Implementation:**

```typescript
// Load new models into separate registry
const newRegistry = await loadModels(newConfig);

// Atomic swap
this.modelRegistry = newRegistry;
```

**Pros:** No downtime, no failed requests

**Cons:** Higher memory usage during swap

### Workaround 4: Retry Failed Requests

**Approach:** Client-side retry on provider errors

**Implementation:**

```typescript
async function chatWithRetry(message, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await chat(message);
    } catch (error) {
      if (error.message.includes("provider") && i < maxRetries - 1) {
        await sleep(1000 * (i + 1)); // Exponential backoff
        continue;
      }
      throw error;
    }
  }
}
```

**Pros:** Transparent to user

**Cons:** Increased latency, doesn't prevent initial failure

## Testing Race Conditions

### Test 1: Reset During Request

**Setup:**

```bash
# Terminal 1: Send slow request
curl -X POST http://localhost:3030/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Write a long essay"}' &

# Terminal 2: Immediately reset models
sleep 2
openclaw models reload
```

**Expected:** Request completes with original model

**Failure:** Request fails with "provider undefined"

### Test 2: Concurrent Reloads

**Setup:**

```bash
# Trigger 5 concurrent reloads
for i in {1..5}; do
  openclaw models reload &
done
wait
```

**Expected:** All reloads succeed, registry consistent

**Failure:** Duplicate models, missing models, or crash

### Test 3: Provider Switch During Streaming

**Setup:**

```bash
# Terminal 1: Start streaming request
curl -X POST http://localhost:3030/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Count to 100 slowly", "stream": true}'

# Terminal 2: Switch provider mid-stream
sleep 5
openclaw models set primary sonnet-4-5
```

**Expected:** Stream continues with original model

**Failure:** Stream switches models mid-response

### Test 4: High Concurrency Reset

**Setup:**

```bash
# Load testing tool
ab -n 1000 -c 50 http://localhost:3030/api/chat &

# Reset during load test
sleep 5
openclaw models reload
```

**Expected:** All requests succeed or retry

**Failure:** Multiple request failures during reset

## Monitoring

### Track In-Flight Requests

**Metrics to monitor:**

```bash
# Current in-flight requests
openclaw metrics get gateway.requests.inflight

# Failed requests during reset
openclaw metrics get models.reset.failed_requests
```

### Alert on Provider Errors

**Create alert:**

```bash
# Monitor logs for provider errors
journalctl --user -u openclaw-gateway -f | \
  grep "provider.*undefined\|Cannot read property.*generate" | \
  while read -r line; do
    echo "⚠️ Model reset race detected: $line"
    # Send alert
  done
```

### Registry Health Check

**Validate registry after reload:**

```bash
#!/bin/bash
# check-model-registry.sh

EXPECTED_MODELS=5
ACTUAL_MODELS=$(openclaw models list --json | jq '. | length')

if [ "$ACTUAL_MODELS" -ne "$EXPECTED_MODELS" ]; then
  echo "⚠️ Model registry inconsistent!"
  echo "Expected: $EXPECTED_MODELS"
  echo "Actual: $ACTUAL_MODELS"
  exit 1
fi

# Check for duplicates
DUPLICATES=$(openclaw models list --json | jq -r '.[].id' | sort | uniq -d)
if [ -n "$DUPLICATES" ]; then
  echo "⚠️ Duplicate models: $DUPLICATES"
  exit 1
fi

echo "✅ Model registry healthy"
```

## Prevention Best Practices

### 1. Avoid Hot Reloads in Production

**Recommendation:** Use config management, deploy new version instead

```bash
# ❌ Hot reload in production
openclaw models reload

# ✅ Deploy new version with new config
git pull
npm install
systemctl --user restart openclaw-gateway
```

### 2. Use Configuration Management

**Approach:** Treat model config as code, version control + CI/CD

```bash
# Store config in git
git commit -m "Switch primary model to Sonnet 4.5"
git push

# CI/CD deploys new config
# Graceful restart with new config
```

### 3. Test Config Changes Locally First

**Pattern:**

```bash
# Test in dev environment
openclaw --env dev models reload
openclaw --env dev test

# If successful, promote to prod
openclaw --env prod deploy
```

### 4. Monitor Reset Operations

**Log all model resets:**

```json
{
  "gateway": {
    "audit": {
      "logModelResets": true,
      "alertOnResetFailures": true
    }
  }
}
```

### 5. Implement Health Checks

**Check model availability before accepting requests:**

```typescript
app.use((req, res, next) => {
  if (!modelManager.isHealthy()) {
    return res.status(503).json({ error: "Models initializing, retry in 5s" });
  }
  next();
});
```

## Long-Term Fix

**Status:** Core code changes required

**PR available:** Not yet (as of 2026.2.19)

**Required changes:**

1. Add in-flight request tracking (`Set<Promise>`)
2. Implement reload lock (`AsyncLock` or `Mutex`)
3. Drain requests before reset (graceful shutdown)
4. Copy-on-write provider updates
5. Coordinate auth refresh with requests
6. Registry consistency validation
7. Health check endpoint

**Complexity:** Medium (requires careful synchronization)

**Risk:** Medium (model loading is critical path)

## Related Issues

- **#20769**: Reset-model race conditions (this issue)
- **#6766**: Registry write races (similar pattern)
- **#18060**: Session lock races (related synchronization issue)

## Related Documentation

- [Model Configuration](/concepts/models)
- [Provider Management](/gateway/providers)
- [Gateway Configuration](/gateway/configuration)

## External Resources

- Issue #20769: <https://github.com/openclaw/openclaw/issues/20769>

---

**Last updated**: February 19, 2026
**Status**: Workarounds available, core fix required
