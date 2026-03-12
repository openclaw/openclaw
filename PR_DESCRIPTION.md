## Summary

- Problem: API keys and sensitive tokens can be accidentally exposed in messages sent to external channels (Telegram, Discord, Slack, etc)
- Why it matters: Leaked credentials pose security risks and can lead to unauthorized access
- What changed: Added automatic detection and redaction of sensitive values in all outbound messages
- What did NOT change: Internal logging, config file formats, existing message delivery logic

## Change Type

- [x] Security hardening
- [x] Feature

## Scope

- [x] Integrations
- [x] API / contracts

## Linked Issue/PR

None

## User-visible / Behavior Changes

- Messages sent to external channels now automatically redact sensitive values
- Redaction format: preserves first 6 and last 4 characters (e.g., `sk-abc…xyz`)
- No configuration required - works automatically on startup
- Scans openclaw.json and environment variables for secrets at startup

## Security Impact

- New permissions/capabilities? `No`
- Secrets/tokens handling changed? `Yes`
- New/changed network calls? `No`
- Command/tool execution surface changed? `No`
- Data access scope changed? `No`

**Explanation**: This PR improves security by preventing accidental exposure of API keys, tokens, and credentials in messages. The redaction happens before messages are sent, using both pattern matching (for known key formats like `sk-`, `ghp-`, etc.) and runtime-discovered values from config/env.

## Repro + Verification

### Environment

- OS: macOS Darwin 25.3.0
- Runtime/container: Node.js
- Model/provider: Any
- Integration/channel: Telegram, Discord, Slack, and all channels using outbound-send-service
- Relevant config: Any config with sensitive values (e.g., `providers.*.apiKey`)

### Steps

1. Configure OpenClaw with API keys in openclaw.json or environment variables
2. Send a message containing an API key (e.g., "My key is sk-1234567890abcdefghij1234567890")
3. Check the message in the external channel (Telegram/Discord/etc)

### Expected

The message should have the key redacted: "My key is sk-123…7890"

### Actual

Keys are properly redacted before being sent to external channels.

## Evidence

- [x] Unit tests added for redaction functionality (`redact.test.ts`)
- [x] Unit tests for config/env scanning (`redact-init.test.ts`)
- [x] Documentation in `docs/security-message-redaction.md`

## Human Verification

**Verified scenarios:**
- sk- prefixed API keys are redacted correctly
- GitHub tokens (ghp_*, github_pat_*) are redacted
- Custom secrets from config are detected and redacted
- Environment variable secrets are detected and redacted
- Short values (<18 chars) are not redacted to avoid false positives
- Special regex characters in secrets are handled properly

**Edge cases checked:**
- Multiple occurrences of same secret in one message
- Nested config objects (up to 10 levels deep)
- Empty/null values handled gracefully
- Pattern-based and dynamic value redaction work together

**What I did NOT verify:**
- Performance impact on high-volume message sending (>1000 msg/sec)
- All 30+ channel integrations individually (tested core outbound path)
- Memory usage with thousands of dynamic sensitive values

## Review Conversations

- [x] I replied to or resolved every bot review conversation I addressed in this PR.
- [x] I left unresolved only the conversations that still need reviewer or maintainer judgment.

## Compatibility / Migration

- Backward compatible? `Yes`
- Config/env changes? `No`
- Migration needed? `No`

No breaking changes. Feature is opt-out via existing `logging.redactSensitive: "off"` config.

## Failure Recovery

**How to disable/revert:**
- Set `logging.redactSensitive: "off"` in openclaw.json
- Or revert the commit

**Files/config to restore:** None (feature is self-contained)

**Known bad symptoms to watch for:**
- If redaction fails, messages will be sent unredacted (graceful degradation)
- Excessive regex matching time on very long messages (>10MB)

## Risks and Mitigations

- **Risk:** Performance overhead from regex matching on every message
  - **Mitigation:** Patterns compiled once at startup; dynamic values use Set for O(1) lookup; 18-char minimum length check skips short strings; early exit if no patterns

- **Risk:** False positives redacting non-sensitive data
  - **Mitigation:** 18-character minimum length; specific pattern matching for known formats; only targets sensitive key names in config

- **Risk:** False negatives missing some secret formats
  - **Mitigation:** Comprehensive default patterns for common formats; runtime discovery from config/env; extensible via `logging.redactPatterns` config

- **Risk:** Memory usage with large number of dynamic values
  - **Mitigation:** Only values ≥18 chars are stored; Set data structure for efficient storage; recursive depth limit (10 levels) prevents stack overflow
