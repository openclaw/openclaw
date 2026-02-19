# Contributing: Raspberry Pi + AWS Bedrock Support

This document provides contribution guidelines specifically for Raspberry Pi and AWS Bedrock integration improvements.

## Overview

This contribution focuses on:
1. **Bug Fixes:** Telegram polling, model validation, configuration errors
2. **Documentation:** Raspberry Pi setup guide, AWS Bedrock cross-region models
3. **Testing:** Platform-specific test cases
4. **Optimization:** Performance tuning for ARM64 platforms

## Bugs Identified

See [BUGS_IDENTIFIED.md](./BUGS_IDENTIFIED.md) for complete bug descriptions.

### Priority 1: Critical Bugs

1. **Telegram Polling Drops Messages** ([Issue Template](./.github/ISSUE_TEMPLATE/telegram_polling_bug.md))
   - Status: Needs investigation
   - Impact: HIGH - Breaks Telegram channel
   - Files: `src/gateway/channels/telegram/*`

2. **Model ID Validation Missing**
   - Status: Needs implementation
   - Impact: MEDIUM - Runtime failures with invalid models
   - Files: `src/config/validation.ts`, `src/models/model-registry.ts`

### Priority 2: Important Fixes

3. **Webhook → Polling Transition Issues**
   - Status: Needs cleanup logic
   - Impact: MEDIUM - Requires manual intervention

4. **Dashboard Auth Fails with Reverse Proxy**
   - Status: Needs documentation
   - Impact: LOW - Workaround exists

## Documentation Additions

### New Documentation

1. **AWS Bedrock + Raspberry Pi Guide**
   - File: [AWS_BEDROCK_RASPBERRY_PI_GUIDE.md](./AWS_BEDROCK_RASPBERRY_PI_GUIDE.md)
   - Complete setup guide tested on Raspberry Pi 5
   - AWS Bedrock model configuration with cross-region inference
   - Performance optimization for ARM64
   - Troubleshooting common issues

### Documentation Updates Needed

1. **docs/channels/telegram.md**
   - Add troubleshooting section
   - Document offset file reset procedure
   - Add webhook → polling transition guide

2. **docs/providers/aws-bedrock.md**
   - Document cross-region model access
   - Explain `us.`, `eu.`, `ap.` prefixes
   - Add model availability table

3. **docs/platforms/raspberry-pi.md** (NEW)
   - Hardware requirements
   - Performance benchmarks
   - Optimization tips
   - Resource monitoring

4. **README.md**
   - Add Raspberry Pi support badge
   - Link to platform-specific guides

## Testing Requirements

### Unit Tests Needed

1. **Telegram Message Flow**
   ```typescript
   // tests/channels/telegram-polling.test.ts
   describe('Telegram Polling', () => {
     it('should process incoming messages', async () => {
       // Mock getUpdates response
       // Verify agent invocation
       // Check messageChannel attribution
     });

     it('should handle offset file correctly', async () => {
       // Test offset persistence
       // Test offset reset on errors
     });
   });
   ```

2. **Model Validation**
   ```typescript
   // tests/models/validation.test.ts
   describe('Model Configuration', () => {
     it('should reject invalid model IDs', async () => {
       // Test with non-existent model
       // Verify error message
     });

     it('should validate provider availability', async () => {
       // Test provider access
       // Test model listing
     });
   });
   ```

### Integration Tests

1. **Raspberry Pi Specific**
   ```typescript
   // tests/integration/raspberry-pi.test.ts
   describe('Raspberry Pi Integration', () => {
     it('should handle memory constraints', async () => {
       // Test with concurrent agents
       // Monitor memory usage
     });

     it('should complete model discovery', async () => {
       // Test discovery on ARM64
       // Verify timeout handling
     });
   });
   ```

2. **AWS Bedrock Cross-Region**
   ```typescript
   // tests/integration/bedrock-regions.test.ts
   describe('Bedrock Cross-Region', () => {
     it('should access models with region prefix', async () => {
       // Test us. prefix models
       // Verify cross-region inference
     });
   });
   ```

## Code Changes Needed

### 1. Telegram Message Handler Fix

**File:** `src/gateway/channels/telegram/polling-handler.ts` (or equivalent)

**Problem:** Messages not dispatched to agent

**Proposed Fix:**
```typescript
// Add debug logging
logger.debug('Telegram message received', {
  updateId: update.update_id,
  messageId: update.message?.message_id,
  from: update.message?.from?.id
});

// Ensure message dispatch
await this.dispatchMessage({
  channel: 'telegram',
  channelId: 'default',
  message: update.message,
  // ... other fields
});

logger.debug('Message dispatched to agent', {
  messageId: update.message?.message_id
});
```

### 2. Model ID Validation

**File:** `src/config/config-manager.ts`

**Addition:**
```typescript
async function validateModelId(modelId: string): Promise<void> {
  const [provider, model] = modelId.split('/');

  // Check provider exists
  const providerConfig = await getProviderConfig(provider);
  if (!providerConfig) {
    throw new ConfigValidationError(
      `Provider '${provider}' not found.\n` +
      `Available providers: ${listProviders().join(', ')}`
    );
  }

  // Check model exists
  const models = await listModels(provider);
  if (!models.includes(model)) {
    throw new ConfigValidationError(
      `Model '${model}' not found in provider '${provider}'.\n` +
      `Run 'openclaw models list' to see available models.`
    );
  }
}
```

### 3. Offset File Cleanup on Mode Change

**File:** `src/gateway/channels/telegram/channel-manager.ts`

**Addition:**
```typescript
async function switchMode(newMode: 'polling' | 'webhook'): Promise<void> {
  const oldMode = this.config.mode;

  if (oldMode === 'webhook' && newMode === 'polling') {
    // Delete webhook
    await this.deleteWebhook();

    // Reset offset file
    const offsetFile = path.join(
      this.configDir,
      'telegram',
      'update-offset-default.json'
    );
    if (fs.existsSync(offsetFile)) {
      fs.unlinkSync(offsetFile);
      logger.info('Deleted offset file for webhook → polling transition');
    }
  }

  // Continue with mode change...
}
```

### 4. Better Error Messages

**File:** `src/config/validation.ts`

**Enhancement:**
```typescript
function validateTelegramConfig(config: TelegramConfig): ValidationResult {
  if (config.dmPolicy === 'open' && !config.allowFrom?.includes('*')) {
    return {
      valid: false,
      error: new ConfigValidationError(
        'Telegram Configuration Error',
        'When dmPolicy is "open", allowFrom must include "*".\n\n' +
        'Fix with:\n' +
        '  openclaw config set channels.telegram.allowFrom \'["*"]\'\n\n' +
        'Or change policy to pairing mode:\n' +
        '  openclaw config set channels.telegram.dmPolicy "pairing"'
      )
    };
  }

  return { valid: true };
}
```

## Building and Testing Locally

### Setup Development Environment

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/openclaw.git
cd openclaw

# Add upstream remote
git remote add upstream https://github.com/openclaw/openclaw.git

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run specific test
npm test -- tests/channels/telegram-polling.test.ts
```

### Testing on Raspberry Pi

```bash
# Build for ARM64
npm run build

# Link for local testing
npm link

# Test locally
openclaw --version

# Run integration tests
npm run test:integration
```

### Testing with AWS Bedrock

```bash
# Set up AWS credentials
export AWS_ACCESS_KEY_ID="your_key"
export AWS_SECRET_ACCESS_KEY="your_secret"
export AWS_REGION="us-east-1"

# Run Bedrock tests
npm run test:bedrock
```

## Submitting Your Contribution

### 1. Create Feature Branch

```bash
git checkout -b fix/telegram-polling-messages
```

### 2. Make Changes

- Follow existing code style
- Add tests for new functionality
- Update documentation

### 3. Test Thoroughly

```bash
# Run all tests
npm test

# Test on Raspberry Pi if possible
npm run build && npm link

# Test manually
openclaw channels status
# Send test messages via Telegram
```

### 4. Commit Changes

```bash
git add .
git commit -m "Fix: Telegram polling now processes incoming messages

- Add message dispatch logging
- Fix event handler binding in polling mode
- Add unit tests for message flow
- Update Telegram channel documentation

Fixes #XXX"
```

### 5. Push and Create PR

```bash
git push origin fix/telegram-polling-messages
```

Then create a Pull Request on GitHub with:
- Clear description of changes
- Link to related issues
- Test results (especially on Raspberry Pi)
- Screenshots if applicable

## Code Style

Follow the existing code style:
- TypeScript strict mode
- ESLint configuration
- Prettier formatting
- JSDoc comments for public APIs

```typescript
/**
 * Processes incoming Telegram updates
 * @param update - Telegram update object from getUpdates
 * @returns Promise that resolves when message is processed
 */
async function processUpdate(update: TelegramUpdate): Promise<void> {
  // Implementation
}
```

## Documentation Style

- Use Markdown with proper headings
- Include code examples for complex concepts
- Add troubleshooting sections
- Keep platform-specific notes clearly marked

Example:
```markdown
### Configuration

Set your bot token:
```bash
openclaw config set channels.telegram.botToken "YOUR_TOKEN"
```

**Raspberry Pi Note:** On Raspberry Pi, use absolute paths in systemd services.
```

## Review Process

1. **Automated Checks:**
   - CI/CD pipeline runs tests
   - Code style validation
   - Build verification

2. **Manual Review:**
   - Maintainer reviews code
   - Checks for breaking changes
   - Verifies documentation

3. **Testing:**
   - Maintainer may request additional tests
   - Platform-specific testing if needed

4. **Merge:**
   - Once approved, PR is merged
   - Changes included in next release

## Questions?

- **GitHub Issues:** https://github.com/openclaw/openclaw/issues
- **Discussions:** https://github.com/openclaw/openclaw/discussions
- **Documentation:** https://docs.openclaw.ai

## Recognition

Contributors are listed in:
- CONTRIBUTORS.md
- Release notes
- Commit history

Thank you for improving OpenClaw! 🦞

---

**Last Updated:** February 18, 2026
**Maintained By:** Community
**Platform Focus:** Raspberry Pi + AWS Bedrock
