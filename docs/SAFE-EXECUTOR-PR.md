# Safe Execution Layer for OpenClaw

> **Disclaimer**: This is a proof-of-concept contribution from outside the core team. We are not OpenClaw/Clawbot experts and have not tested this integration against a running Clawbot instance. The code demonstrates that capability-based security *can* work with OpenClaw architecture, but will likely need adaptation and review from maintainers who understand the codebase deeply. We are showing this works in principle, not shipping production-ready code.

## Summary

This PR adds a defense-in-depth security module for OpenClaw powered by [ajs-clawbot](https://www.npmjs.com/package/ajs-clawbot), providing **Runtime-Layer Permission** security that makes dangerous operations impossible rather than merely discouraged.

## Performance

The sandbox overhead is negligible:

| Metric | Value |
|--------|-------|
| **Sandbox overhead per execution** | 0.174ms |
| As % of typical API call (100ms) | 0.17% |
| As % of typical LLM call (1000ms) | 0.017% |

See [ajs-clawbot BENCHMARK.md](https://github.com/tonioloewald/ajs-clawbot/blob/main/BENCHMARK.md) for methodology.

## The Problem

When you expose your OpenClaw bot to external users (Discord servers, Telegram groups, etc.), they can craft messages that exploit prompt injection to:
- Read sensitive files (.env, SSH keys, credentials)
- Execute arbitrary commands
- Exfiltrate data via network requests
- Cause denial of service through flooding or infinite loops

Current "fixes" (regex filters, prompt engineering) use **Application-Layer Permission** - the capability exists and a boolean decides whether to use it. This is trivially bypassed via prompt injection.

## The Solution: Runtime-Layer Permission

This module uses **ajs-clawbot capability-based security** where dangerous capabilities literally do not exist until explicitly granted. There is nothing to bypass.

## What This PR Does (and Does Not Do)

### What it does:
- Adds integration layer mapping OpenClaw message sources to trust levels
- Provides rate limiting and flood protection infrastructure
- Demonstrates the capability-based security model
- Passes 24 integration tests

### What it does not do:
- Replace existing OpenClaw skill execution (this is additive, not a replacement)
- Route skills through the AJS VM (that would require converting skills to AJS)
- Guarantee production readiness (needs testing by maintainers who know the codebase)

This is a "foot in the door" - showing the architecture works so the team can evaluate whether to adopt it.

## Features

### 1. Zero Capabilities by Default
Skills start with nothing. They cannot read files, fetch URLs, or execute commands unless explicitly granted.

### 2. Trust Levels by Message Source
- CLI user -> full trust
- Owner flag -> full trust  
- Trusted users -> shell trust
- DMs -> write trust
- Group chats -> llm trust
- Public channels -> network trust

### 3. Always-Blocked Patterns
Sensitive files blocked regardless of trust level:
- Environment: .env, .env.*
- SSH: id_rsa, id_ed25519, .ssh/*
- Credentials: credentials.*, secrets.*
- Certificates: *.pem, *.key
- Cloud: .aws/*, .gcloud/*, .kube/*

### 4. SSRF Protection
- Private IPs: 10.x, 192.168.x, 127.x, etc.
- Cloud metadata: 169.254.169.254
- Blocked hostnames: localhost, *.local, metadata.google.internal

### 5. Rate Limiting and Flood Protection
- Self-message rejection (prevents recursion attacks)
- Per-requester and global rate limits
- Automatic cooldown

### 6. Process Tree Killing
Timeouts kill entire process trees, not just parent processes.

## Files Changed

- src/safe-executor/index.ts - Module exports
- src/safe-executor/openclaw-executor.ts - OpenClaw-specific integration
- src/safe-executor/config.ts - Configuration loading
- src/safe-executor/safe-executor.test.ts - 24 integration tests

## Dependencies

- ajs-clawbot@^0.2.7 - Runtime-layer capability-based security

## Testing

24 integration tests covering trust levels, security utilities, and process utilities.
The underlying ajs-clawbot package has 254 tests.

## Backwards Compatibility

This module is opt-in and does not change existing behavior.
