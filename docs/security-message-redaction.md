# Security: Sensitive Value Redaction in Outbound Messages

## Overview

Implements automatic detection and redaction of sensitive information (API keys, tokens, credentials, etc.) in all outbound messages sent through Telegram, Discord, Slack, and other channels.

## Modified Files

### 1. `src/logging/redact.ts` (Enhanced)

**Changes:**
- Added `dynamicSensitiveValues: Set<string>` to store runtime-discovered sensitive values
- Enhanced `redactText()` function to redact dynamic values first, then apply pattern-based redaction
- New public APIs:
  - `addSensitiveValue(value: string)`: Add a single sensitive value
  - `addSensitiveValues(values: string[])`: Add multiple sensitive values
  - `clearDynamicSensitiveValues()`: Clear all dynamic values
  - `getDynamicSensitiveValuesCount()`: Get count of registered values

**Features:**
- Pattern-based matching (existing functionality)
- Exact string matching for dynamic values (new)
- Redaction format: preserves first 6 and last 4 characters, replaces middle with `…`

### 2. `src/logging/redact-init.ts` (New)

**Purpose:**
- Scan `openclaw.json` configuration for sensitive values
- Scan environment variables for secrets
- Automatically register discovered values for redaction

**Sensitive Key Patterns:**
```javascript
const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /private[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /auth/i,
];
```

**Scan Scope:**
- `agents.defaults.sandbox.docker.env`
- `channels.*` (Telegram, Discord, Slack, etc.)
- `gateway.*`
- `plugins[*].*`
- All environment variables

### 3. `src/infra/outbound/outbound-send-service.ts` (Modified)

**Changes:**
- Added message redaction in `executeSendAction()` before sending
- Added poll content redaction in `executePollAction()` before sending

**Code Example:**
```typescript
const redactedMessage = redactSensitiveText(params.message);
// Use redactedMessage instead of params.message
```

### 4. `src/cli/program/preaction.ts` (Modified)

**Changes:**
- Added initialization call in `registerPreActionHooks()` preAction hook
- Runs after `ensureConfigReady()` to ensure config is loaded
- Wrapped in try-catch to ensure initialization failures don't block startup

**Code Example:**
```typescript
try {
  const { initializeRedactionWithConfig } = await import("../../logging/redact-init.js");
  const { loadConfig } = await import("../../config/config.js");
  const config = loadConfig();
  initializeRedactionWithConfig(config);
} catch {
  // Best-effort initialization
}
```

## Workflow

### At Startup
1. CLI starts → preAction hook executes
2. Load config file (`ensureConfigReady`)
3. Call `initializeRedactionWithConfig(config)`
4. Scan config and environment variables for sensitive values
5. Register values via `addSensitiveValues()`

### When Sending Messages
1. Agent/user calls send message
2. → `executeSendAction()` or `executePollAction()`
3. → Call `redactSensitiveText()` to redact content
4. → Send redacted message to TG/Discord/Slack/etc

## Redaction Examples

### Example 1: sk- prefixed keys
```
Original: sk-3hjd98348hfkwduy83e4iuhfsa7t5623
Redacted: sk-3hj…5623
```

### Example 2: GitHub Token
```
Original: ghp_1234567890abcdefghij1234567890
Redacted: ghp_12…7890
```

### Example 3: Environment variable format
```
Original: API_KEY=sk-proj-1234567890abcdefghijklmnopqrstuvwxyz12345678
Redacted: API_KEY=sk-pro…5678
```

### Example 4: Runtime-discovered config values
If `openclaw.json` contains:
```json
{
  "channels": {
    "telegram": {
      "accounts": {
        "default": {
          "botToken": "1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ"
        }
      }
    }
  }
}
```

The token `1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ` will be automatically extracted at startup.
Any message containing this exact value will be redacted to `123456…wxYZ`

## Supported Key Formats

### Pattern-based Detection (Existing)
- `sk-*` - OpenAI/Anthropic API keys
- `ghp_*` - GitHub personal access tokens
- `github_pat_*` - GitHub fine-grained tokens
- `xox*-*` - Slack tokens
- `xapp-*` - Slack app tokens
- `gsk_*` - Google Service Keys
- `AIza*` - Google API keys
- `pplx-*` - Perplexity API keys
- `npm_*` - NPM tokens
- `digits:*` - Telegram bot tokens
- PEM private key blocks
- Bearer tokens
- Environment variable assignments
- JSON field formats

### Dynamic Value Detection (New)
- Actual key values extracted from `openclaw.json`
- Actual key values extracted from environment variables

## Security Features

1. **Minimum Length**: Only redacts values ≥ 18 characters to avoid false positives
2. **Context Preservation**: Preserves first 6 and last 4 characters for identification
3. **Recursive Scanning**: Scans nested config objects up to 10 levels deep
4. **Failure Isolation**: Initialization failures don't block application startup
5. **Performance**: Uses Set for O(1) lookups, patterns compiled once
6. **Zero Configuration**: Works automatically, no manual setup required

## Testing

### Unit Tests
- `redact.test.ts` - Core redaction functionality
- `redact-init.test.ts` - Configuration scanning

### Test Coverage
- Pattern-based redaction for common key formats
- Dynamic value redaction
- Config scanning
- Environment variable scanning
- Edge cases (special characters, multiple occurrences, etc.)

## Notes

1. **Scope**: Redaction only applies to outbound messages, not internal logs
2. **Performance**: Minimal overhead from regex matching and Set lookups
3. **Coverage**: Currently integrated at `outbound-send-service.ts` level; direct channel API calls may need separate handling
4. **Timing**: Initialization occurs during CLI startup preAction hook

## Future Improvements

1. Extend redaction to additional send paths (e.g., WebSocket messages)
2. Support custom redaction formats (asterisks, full hiding, etc.)
3. Add redaction statistics and logging
4. Support whitelist (keys that should not be redacted)
5. Add integration tests

---

**Implementation Date**: 2026-03-13
**Branch**: security-message-redaction
