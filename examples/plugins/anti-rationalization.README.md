# Anti-Rationalization Plugin

Detects when the agent is rationalizing incomplete work and forces it to continue.

## How It Works

Listens to `agent_end` hook and reviews the assistant's final message for common rationalization patterns:

**Regex Patterns:**
- "pre-existing", "out of scope", "beyond the scope"
- "too many issues/errors/problems"
- "leave/defer this for a follow-up"
- "I'll skip/defer/leave/ignore"
- "can't fix all/everything"
- "should be fixed separately"

**Excuse Phrases:**
- "as mentioned", "as noted", "as discussed"
- "not directly related"
- "outside my scope"
- "require manual"
- "beyond what I can"

**Heuristics:**
- Lists many issues (5+) without code changes
- Asks "want me to try again?" when task is incomplete

## Configuration

```json5
{
  "plugins": {
    "entries": {
      "anti-rationalization": {
        "enabled": true,
        "config": {
          "aggressive": false  // If true, force continue on single pattern match
        }
      }
    }
  }
}
```

**Default mode:** Requires 2+ patterns to force continuation  
**Aggressive mode:** Forces continuation on any single pattern

## Example Behavior

### Agent Output (Rationalized):
```
I've fixed the main issue, but there are a few remaining problems:
- Linter errors in utils.ts
- Missing tests for the new feature
- Type errors in components/

These issues are pre-existing and out of scope for this task.
I'll leave them for a follow-up.
```

### Plugin Action:
```typescript
ctx.injectMessage(`You are rationalizing incomplete work. Detected patterns:
  - /\\b(pre-existing|out of scope|beyond the scope)\\b/i
  - /\\b(leave|defer|save) (this|that|these|those) for (a |the )?(follow-?up|later|future)\\b/i
  - heuristic: lists many issues without code

Go back and finish the task properly.`);
```

### Agent Continues:
Agent receives the injected message and goes back to fix the linter errors, add tests, and resolve type errors.

## Installation

**Option 1: Drop in plugins directory**
```bash
cp anti-rationalization.ts ~/.openclaw/plugins/
```

**Option 2: Reference in config**
```json5
{
  "plugins": {
    "load": {
      "extraDirs": ["./examples/plugins"]
    },
    "entries": {
      "anti-rationalization": {
        "enabled": true
      }
    }
  }
}
```

## Logging

Watch for plugin activity:
```bash
# Look for anti-rationalization logs
tail -f ~/.openclaw/gateway.log | grep anti-rationalization
```

**Log levels:**
- `debug`: Pattern checking details
- `info`: Mode and config info
- `warn`: Rationalization detected
- `error`: Plugin failures

## Tuning

### Too Aggressive?
- Set `aggressive: false` (default)
- Add specific patterns to skip
- Increase threshold from 2 to 3+ patterns

### Too Permissive?
- Set `aggressive: true`
- Add more patterns
- Lower threshold to 1 pattern

### Custom Patterns

Fork and modify the `RATIONALIZATION_PATTERNS` and `EXCUSE_PHRASES` arrays to match your workflow.

## Inspired By

[Trail of Bits Claude Code Config](https://github.com/trailofbits/claude-code-config#anti-rationalization-gate)

> Claude has a tendency to declare victory while leaving work undone. It rationalizes skipping things: "these issues were pre-existing," "fixing this is out of scope," "I'll leave these for a follow-up." A prompt-based Stop hook catches this by asking a fast model to review Claude's final response for cop-outs before allowing it to stop.

## Limitations

- **Pattern-based detection** - May miss novel rationalization styles
- **No LLM review** - Unlike Claude Code's prompt hooks, this uses regex/heuristics
- **False positives possible** - Legitimate "out of scope" statements may trigger

For higher accuracy, consider using a fast model (Haiku) to review the message instead of regex patterns.

## Future Enhancements

- [ ] Optional LLM-based review (send to Haiku for judgment)
- [ ] Learning mode (log patterns without forcing continuation)
- [ ] Per-agent configuration
- [ ] Whitelist for legitimate "out of scope" responses
- [ ] Metrics (rationalization detection rate, false positive tracking)
