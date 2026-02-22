# OpenClaw v2026.2.17 - Bugs Identified

**Testing Environment:**

- Platform: Raspberry Pi 5 (ARM64)
- OS: Linux 6.12.47+rpt-rpi-2712
- Node: v22.22.0
- OpenClaw Version: 2026.2.17
- Date: February 18, 2026

---

## Bug #1: Telegram Polling Silently Drops Messages

**Severity:** High
**Status:** Confirmed
**Affects:** Telegram channel in polling mode

### Description

When Telegram channel is configured in polling mode, `getUpdates` successfully fetches incoming messages but they are never passed to the AI agent for processing. Messages are silently consumed and dropped without any error logs.

### Reproduction Steps

1. Configure Telegram bot with polling mode (default)
2. Set `dmPolicy: "open"` and `allowFrom: ["*"]`
3. Send a message to the bot via Telegram
4. Observe: No agent run logs with `messageChannel=telegram`
5. Verify: `getUpdates?offset=-1` returns 0 messages (consumed but not processed)

### Expected Behavior

- Incoming Telegram messages should trigger agent runs
- Logs should show `messageChannel=telegram` entries
- Bot should respond to user messages

### Actual Behavior

- Agent never invoked for Telegram messages
- All agent runs show `messageChannel=webchat` only
- No error logs generated
- Messages marked as consumed by Telegram API

### Evidence

```json
// Gateway logs show polling is active
{"subsystem":"gateway/channels/telegram"},"[default] starting provider (@bot)"

// But no agent runs with telegram channel
// Only shows: messageChannel=webchat
// Never shows: messageChannel=telegram
```

### Root Cause Analysis

The message handler for Telegram polling mode fails to dispatch messages to the agent subsystem. The `getUpdates` polling loop is functional but the callback/handler that processes incoming updates is not triggering agent invocations.

### Workaround

Delete the offset file and restart gateway:

```bash
systemctl --user stop openclaw-gateway.service
rm ~/.openclaw/telegram/update-offset-default.json
systemctl --user start openclaw-gateway.service
```

**Note:** This workaround worked in our testing but may be environment-specific or timing-dependent.

### Additional Context

- Outbound messages work correctly (bot can send messages)
- Status checks show "running" with no errors
- Plugin is enabled: `plugins.entries.telegram.enabled: true`
- This issue does NOT affect webhook mode (if supported)

---

## Bug #2: Telegram Webhook Conflict Causes Persistent Polling Failure

**Severity:** Medium
**Status:** Confirmed
**Affects:** Telegram channel switching between webhook and polling modes

### Description

When a Telegram bot has a webhook configured and the user switches to polling mode, OpenClaw repeatedly fails with 409 Conflict errors. Even after deleting the webhook via Telegram API, the conflict persists until the offset file is manually deleted.

### Reproduction Steps

1. Configure Telegram bot with webhook URL
2. Change configuration to polling mode
3. Delete webhook via API: `deleteWebhook`
4. Restart gateway
5. Observe continuous 409 errors in logs

### Expected Behavior

- Deleting webhook should allow polling to start
- Gateway should handle mode transitions gracefully

### Actual Behavior

```
Telegram getUpdates conflict: Call to 'getUpdates' failed!
(409: Conflict: can't use getUpdates method while webhook is active;
use deleteWebhook to delete the webhook first); retrying in 30s.
```

Errors repeat indefinitely even after webhook is deleted.

### Root Cause Analysis

The offset file (`~/.openclaw/telegram/update-offset-default.json`) retains state from webhook mode. When switching to polling, OpenClaw doesn't detect the stale offset and continues using it, causing conflicts.

### Solution

Gateway should:

1. Detect webhook → polling mode changes
2. Automatically reset offset file when mode changes
3. Validate webhook status before starting polling
4. Provide clear error messages with recovery steps

### Workaround

```bash
# Delete webhook via Telegram API
curl -X POST "https://api.telegram.org/bot<TOKEN>/deleteWebhook"

# Delete offset file
rm ~/.openclaw/telegram/update-offset-default.json

# Restart gateway
systemctl --user restart openclaw-gateway.service
```

---

## Bug #3: Config Validation Error Not User-Friendly

**Severity:** Low
**Status:** Confirmed
**Affects:** Channel configuration validation

### Description

When `dmPolicy: "open"` is set without `allowFrom: ["*"]`, the error message is cryptic and doesn't suggest the fix.

### Error Message

```
Error: Config validation failed: channels.telegram.allowFrom:
channels.telegram.dmPolicy="open" requires channels.telegram.allowFrom
to include "*"
```

### Suggested Improvement

```
Error: Telegram configuration mismatch

Your configuration has:
  dmPolicy: "open"
  allowFrom: []

When dmPolicy is "open", allowFrom must include "*" to allow all users.

Fix with:
  openclaw config set channels.telegram.allowFrom '["*"]'

Or change policy:
  openclaw config set channels.telegram.dmPolicy "pairing"
```

---

## Bug #4: Invalid Model Identifier Accepted in Config

**Severity:** Medium
**Status:** Confirmed
**Affects:** Model configuration validation

### Description

OpenClaw allows setting non-existent model IDs without validation, causing runtime failures.

### Reproduction Steps

1. Set model: `openclaw config set agents.defaults.model.primary "amazon-bedrock/us.anthropic.claude-opus-4-6-v1:0"`
2. Model doesn't exist in AWS Bedrock
3. Gateway starts without errors
4. Agent invocations fail silently or with cryptic errors

### Expected Behavior

- Validate model IDs against available models during config set
- Show clear error: "Model 'X' not found in provider 'Y'"
- Suggest: `openclaw models list` to see available models

### Actual Behavior

- Invalid model ID accepted
- Failures occur only at runtime during agent invocation
- Error messages don't clearly indicate model unavailability

### Solution

Add model validation in `config set` command:

```javascript
// Pseudo-code
async function setModel(modelId) {
  const provider = parseProvider(modelId);
  const availableModels = await listModels(provider);

  if (!availableModels.includes(modelId)) {
    throw new Error(
      `Model '${modelId}' not found.\n` + `Run 'openclaw models list' to see available models.`,
    );
  }

  // ... set config
}
```

---

## Bug #5: AWS Bedrock Cross-Region Model Access Not Documented

**Severity:** Medium
**Status:** Documentation Gap
**Affects:** AWS Bedrock model configuration

### Description

OpenClaw doesn't document that AWS Bedrock requires `us.`, `eu.`, or `ap.` prefixes for cross-region inference when using models in `us-east-1` (standard config).

### Issue

Documentation shows:

```json
"model": "amazon-bedrock/anthropic.claude-opus-4-5-20251101-v1:0"
```

This works in the model's native region but fails in `us-east-1` without the prefix.

### Correct Configuration

```json
"model": "amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0"
```

### Missing Documentation

- Prefix requirements for cross-region inference
- Region-specific model availability
- How to test model access before configuring

### Suggested Addition to Docs

````markdown
### AWS Bedrock Cross-Region Models

When using AWS Bedrock in `us-east-1`, most Claude models require a region prefix:

- `us.anthropic.claude-opus-4-5-20251101-v1:0` (correct)
- `anthropic.claude-opus-4-5-20251101-v1:0` (fails)

Region prefixes:

- `us.` - US West (Oregon)
- `eu.` - Europe (Frankfurt)
- `ap.` - Asia Pacific (Tokyo)

Test model access:

```bash
openclaw models list | grep bedrock
```
````

See: https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html

````

---

## Bug #6: Dashboard Authentication Fails After Config Change

**Severity:** Medium
**Status:** Intermittent
**Affects:** Gateway Control UI

### Description
After modifying `gateway.controlUi` settings, the dashboard becomes inaccessible with 1008 errors (device token mismatch), even when using the correct auth token.

### Trigger
Removing `allowInsecureAuth: true` when using Cloudflare tunnel causes dashboard to fail.

### Root Cause
Cloudflare tunnel terminates TLS, making gateway think requests are insecure. Without `allowInsecureAuth: true`, authentication fails with device token mismatch.

### Solution Required
1. Document the `allowInsecureAuth` requirement for reverse proxies
2. Add warning when user removes it while using tunnels
3. Better error message: "If using a reverse proxy, set gateway.controlUi.allowInsecureAuth=true"

### Current Workaround
```bash
openclaw config set gateway.controlUi.allowInsecureAuth true
systemctl --user restart openclaw-gateway.service
````

---

## Raspberry Pi Specific Issues

### Issue: Memory Pressure During Model Discovery

**Description:**
On Raspberry Pi 5 (8GB RAM), model discovery causes temporary memory pressure.

**Evidence:**

```
[huggingface-models] Discovery failed: TimeoutError:
The operation was aborted due to timeout, using static catalog
```

**Impact:** Low - Falls back to static catalog
**Status:** Non-blocking warning

### Recommendation

Document Raspberry Pi resource considerations:

- Minimum 4GB RAM recommended
- 8GB RAM optimal for multiple concurrent agents
- Consider disabling unused model providers to reduce overhead

---

## Enhancement Requests

### 1. Better Error Recovery for Channel Conflicts

Add automatic recovery for webhook/polling conflicts:

```bash
openclaw channels recover telegram
```

Should:

- Check and delete active webhooks
- Reset offset files
- Clear polling state
- Restart channel gracefully

### 2. Model Testing Command

Add model validation:

```bash
openclaw models test amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0
```

Output:

```
Testing model: amazon-bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0
✓ Provider: amazon-bedrock (authenticated)
✓ Model: us.anthropic.claude-opus-4-5-20251101-v1:0 (available)
✓ Test invocation: Success (245ms)
✓ Context window: 200,000 tokens
✓ Max output: 8,192 tokens

Model is ready for use.
```

### 3. Interactive Troubleshooting

Add troubleshooting wizard:

```bash
openclaw doctor --interactive
```

Should guide users through:

- Channel connectivity tests
- Model availability checks
- Configuration validation
- Log analysis for common issues

### 4. Raspberry Pi Optimization Mode

Add performance preset:

```bash
openclaw config preset raspberry-pi
```

Should configure:

- Reduced model discovery timeout
- Lower concurrent agent limit
- Memory-efficient compaction mode
- Disabled unnecessary providers

---

## Testing Recommendations

### Automated Tests Needed

1. **Telegram Polling Test**
   - Send test message via API
   - Verify agent invocation
   - Check response delivery
   - Validate message channel attribution

2. **Model Configuration Validation**
   - Test invalid model IDs
   - Verify provider availability
   - Check cross-region access
   - Validate model metadata

3. **Channel Mode Transitions**
   - Switch webhook → polling
   - Switch polling → webhook
   - Verify state cleanup
   - Test recovery procedures

4. **Raspberry Pi Integration Tests**
   - Memory usage under load
   - Model discovery performance
   - Concurrent agent handling
   - Long-running stability

---

## Files Requiring Changes

### Core Files

- `src/gateway/channels/telegram/*.ts` - Telegram message handler
- `src/gateway/channels/channel-manager.ts` - Mode transition logic
- `src/config/validation.ts` - Model validation
- `src/models/model-registry.ts` - Model availability checking

### Documentation

- `docs/channels/telegram.md` - Add troubleshooting section
- `docs/providers/aws-bedrock.md` - Cross-region model docs
- `docs/platforms/raspberry-pi.md` - New file for Pi-specific docs
- `README.md` - Add Raspberry Pi support badge

### Tests

- `tests/channels/telegram-polling.test.ts` - New test file
- `tests/models/validation.test.ts` - Model config validation
- `tests/integration/raspberry-pi.test.ts` - Pi-specific tests

---

## Summary

**Critical Bugs:** 1 (Telegram polling drops messages)
**High Priority:** 2 (Webhook conflicts, model validation)
**Medium Priority:** 3 (Config validation, dashboard auth, documentation gaps)
**Low Priority:** 1 (Error message clarity)

**Platform Support:**

- ✅ AWS Bedrock fully functional (with correct config)
- ✅ Raspberry Pi 5 works well (minor optimization opportunities)
- ⚠️ Telegram requires manual intervention to start working

**Next Steps:**

1. Fix Telegram polling message handler
2. Add model configuration validation
3. Improve error messages and documentation
4. Add Raspberry Pi optimization guide
5. Create automated tests for identified issues
