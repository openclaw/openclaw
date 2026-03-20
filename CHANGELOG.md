# Changelog

## [Unreleased]

### Added
- **Type-aware payload sanitization** - Prevents `sanitizeSurrogates()` from corrupting signed Anthropic thinking blocks (#27825)
  - New `sanitizePayload()` utility with intelligent thinking block detection
  - Configurable preservation of signed thinking blocks (default: enabled)
  - Modern UTF-16 surrogate handling with `String.prototype.toWellFormed()` support
  - Comprehensive test coverage for edge cases and nested structures
  - Feature flags and gradual rollout support
  - Observability metrics for monitoring sanitization activity

### Changed
- **Safe-by-default behavior** - Thinking blocks are now preserved by default to prevent data corruption
- **Enhanced error handling** - Sanitization failures no longer break request pipelines

### Fixed
- **Issue #27825** - Signed Anthropic thinking blocks are no longer corrupted during session history replay
- **Surrogate character handling** - Lone UTF-16 surrogates are now properly sanitized without affecting valid content

### Security
- **Development log exposure** - Local development logs are no longer committed to repository
- **Buffer overflow protection** - Enhanced surrogate handling prevents potential security issues

## Migration Guide

For existing integrations using direct `sanitizeSurrogates()` calls:

```javascript
// Before
const cleaned = sanitizeSurrogates(content);

// After  
import { sanitizePayload } from './lib/utils/payloadSanitizer.js';
const cleaned = sanitizePayload(content);
```

For Anthropic provider integrations:

```javascript
// Integration point in your Anthropic provider
import { sanitizeAnthropicPayload } from './lib/providers/anthropicIntegration.js';

// Before sending request
const cleanPayload = sanitizeAnthropicPayload(apiPayload);
```

## Configuration

Environment variables for controlling sanitization behavior:

- `OPENCLAW_SANITIZE_PAYLOADS` - Enable/disable sanitization (default: true)
- `OPENCLAW_PRESERVE_THINKING` - Preserve thinking blocks (default: true) 
- `OPENCLAW_SANITIZE_METRICS` - Enable metrics collection (default: false)
- `OPENCLAW_SANITIZE_ROLLOUT` - Rollout percentage 0-100 (default: 100)