## Summary

Adds automatic transcript sharing for multi-agent group chats on platforms where bots cannot see each other's messages (primarily Telegram and Signal).

## Problem

When multiple AI agents are bound to the same Telegram group, they cannot see each other's responses due to the Telegram Bot API limitation. This causes:
- Redundant responses (both agents answer the same question)
- Contradictory information
- Poor coordination between agents

Currently, users must manually maintain transcript files and rely on agent discipline to update them — which is error-prone.

## Solution

A gateway-level hook system that:
1. **Automatically logs** agent responses to a shared transcript file after delivery
2. **Injects recent peer entries** into agent context on inbound messages

### Key Features

- **Platform-aware**: No-op on Slack/Discord/IRC (native bot visibility)
- **NO_REPLY filtering**: Silent responses are not logged
- **Configurable**: Transcript path, context limit, pruning, format (markdown/json)
- **Zero agent involvement**: Gateway handles everything

## Configuration

```json5
{
  multiAgentGroups: {
    "-100123456789": {
      transcriptPath: "~/.openclaw/shared/team-transcript.md",
      contextLimit: 20,        // entries to inject
      pruneAfterHours: 48,     // auto-cleanup
      format: "markdown"       // or "json"
    }
  }
}
```

## Files Added

| File | Purpose |
|------|---------|
| `src/config/types.multi-agent.ts` | Type definitions |
| `src/config/multi-agent-groups.ts` | Config resolution + helpers |
| `src/hooks/bundled/multi-agent-transcript.ts` | Post-response hook |
| `src/context-engine/multi-agent-transcript.ts` | Context injection |
| `test/multi-agent-transcript.test.ts` | Unit tests (20+ cases) |
| `docs/features/multi-agent-transcript.md` | Documentation |

## Integration Points (TODO for maintainers)

1. Register hook in `src/hooks/bundled/index.ts`
2. Call `injectMultiAgentTranscript()` in system prompt builder
3. Add `multiAgentGroups` to config schema validation

## Testing

- [x] Unit tests for config resolution
- [x] Unit tests for platform detection
- [x] Unit tests for NO_REPLY filtering
- [x] Unit tests for entry formatting
- [x] Unit tests for context injection
- [x] Unit tests for pruning

## AI Assistance Disclosure

This PR was developed with AI assistance (Claude). The implementation was:
- Fully designed with problem analysis and edge case consideration
- Peer reviewed (design + code) before submission
- Tested via unit tests

I understand what the code does and can explain all design decisions.

## Related

- Addresses the Telegram bot-to-bot visibility limitation
- Inspired by real multi-agent coordination challenges in production deployments
