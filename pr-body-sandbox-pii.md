## Summary

When an agent fails to start due to a sandbox security violation, the full raw error message was being posted to the configured channel (Discord, Telegram, etc.) as if it were the agent's reply. This leaks sensitive internal information to public-facing channels.

**Example of what was leaking:**

```
⚠️ Agent failed before reply: Sandbox security: bind mount "/home/user/.openclaw/sandbox-configs/config.json:/app/config.json:ro" source "/home/user/.openclaw/sandbox-configs/config.json" is outside allowed roots (/home/user/.openclaw/workspace-agent).
```

This exposes full filesystem paths including OS usernames, sandbox configuration details, workspace directory structure, and config file names.

## Details

Added `isSandboxSecurityError()` to the error classification module. When a sandbox security error is detected in `runAgentTurnWithFallback`, the channel receives a safe generic message instead of the raw error:

```
⚠️ Agent failed to start. Check logs: openclaw logs --follow
```

The original error is still logged internally via `defaultRuntime` — it is only redacted from the outbound channel payload.

The fix follows the same pattern already used for billing errors, rate limit errors, and other sensitive failure modes in `agent-runner-execution.ts`.

## Related Issues

Fixes #51275

## How to Validate

1. Configure a sandbox bind mount with a source path outside the allowed workspace root
2. Trigger the agent via a channel (Discord, Telegram, etc.)
3. Confirm the channel receives the generic message, not the raw path
4. Confirm `openclaw logs --follow` still shows the full error internally

## Pre-Merge Checklist

- [x] Updated relevant documentation and README (if needed)
- [x] Added/updated tests (if needed)
- [ ] Noted breaking changes (if any)
- [x] Validated on required platforms/methods:
  - [x] Windows
    - [x] npm run
