# Anti-Rationalization Plugin

Uses an LLM (Haiku) to detect when the agent is rationalizing incomplete work and forces it to continue.

## How It Works

Uses a **fast model (Haiku) to review** the assistant's final message for rationalization:

**LLM Judgment Prompt:**
```
Review the assistant's final response for signs of rationalizing incomplete work.

Common rationalization patterns:
- Claiming issues are "pre-existing" or "out of scope" to avoid fixing them
- Saying there are "too many issues" to address all of them
- Deferring work to a "follow-up" that was not requested
- Listing problems without fixing them
- Skipping test/lint failures with excuses
- Asking "want me to try again?" when task is incomplete

Respond with JSON:
{
  "incomplete": true/false,
  "reason": "Why the work is incomplete",
  "confidence": 0-100
}
```

**LLM Response Example:**
```json
{
  "incomplete": true,
  "reason": "The assistant listed 3 linter errors and type issues but did not fix them, claiming they are 'out of scope' despite no such limitation in the original task.",
  "confidence": 85
}
```

## Configuration

```json5
{
  "plugins": {
    "entries": {
      "anti-rationalization": {
        "enabled": true,
        "config": {
          "model": "anthropic/claude-haiku-4-5-20251001",  // Fast judgment model
          "confidenceThreshold": 70,  // Minimum confidence % to force continuation
          "fallbackToRegex": true     // Use regex if LLM call fails
        }
      }
    }
  }
}
```

**Configuration Options:**
- `model`: Which model to use for review (default: Haiku - fast and cheap)
- `confidenceThreshold`: Min confidence % to inject message (default: 70)
- `fallbackToRegex`: If LLM fails, use simple regex patterns (default: true)

## Example Behavior

### Agent Output (Rationalized):
```
I've fixed the main authentication bug. There are still a few issues:
- Linter errors in utils.ts
- Missing tests for the new feature
- Type errors in components/

These issues are pre-existing and out of scope for this task.
```

### Plugin Review:
```
Calling Haiku for judgment...

Response:
{
  "incomplete": true,
  "reason": "Assistant lists concrete fixable issues but claims they're out of scope without justification. No evidence these are pre-existing.",
  "confidence": 88
}

Confidence: 88% >= 70% threshold
✅ Forcing continuation
```

### Injected Message:
```
Assistant lists concrete fixable issues but claims they're out of scope without justification. 
No evidence these are pre-existing.
```

### Agent Continues:
Agent receives feedback, goes back and fixes the linter errors, adds tests, and resolves type errors.

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
tail -f ~/.openclaw/gateway.log | grep anti-rationalization
```

**Log levels:**
- `debug`: Review details, confidence scores
- `info`: Configuration, low-confidence skips
- `warn`: Forcing continuation
- `error`: LLM call failures

## Tuning

### Too Aggressive?
- Increase `confidenceThreshold` from 70 to 80 or 90
- Review logs to see what confidence scores you're getting

### Too Permissive?
- Lower `confidenceThreshold` from 70 to 50 or 60
- Use a different model (experiment with Sonnet for higher accuracy)

### LLM Calls Failing?
- Check that `openclaw run --model haiku` works standalone
- Enable `fallbackToRegex: true` for simple pattern detection
- Check timeout (currently 10s)

### Cost Optimization

**Per judgment:**
- Input: ~200 tokens (prompt + assistant message sample)
- Output: ~50 tokens (JSON response)
- **~250 tokens per review**

**With Haiku ($0.25/M input, $1.25/M output):**
- Cost per review: ~$0.0001 (one hundredth of a cent)
- 10,000 reviews: ~$1

Extremely cheap - the judgment model runs on every `agent_end`, but at Haiku prices it's negligible.

## Inspired By

[Trail of Bits Claude Code Config](https://github.com/trailofbits/claude-code-config#anti-rationalization-gate)

> Claude has a tendency to declare victory while leaving work undone. It rationalizes skipping things: "these issues were pre-existing," "fixing this is out of scope," "I'll leave these for a follow-up." A prompt-based Stop hook catches this by asking a fast model to review Claude's final response for cop-outs before allowing it to stop.

## Advantages Over Regex

✅ **Contextual understanding** - Knows when "out of scope" is legitimate
✅ **Fewer false positives** - Doesn't trigger on valid responses
✅ **Better detection** - Catches novel rationalization styles
✅ **Confidence scores** - Tunable threshold for precision/recall

## Limitations

- **Requires LLM call** - Adds ~1-2s latency to agent_end
- **Can still miss subtle cases** - LLMs aren't perfect judges
- **Needs OpenClaw CLI** - Uses `openclaw run` for model calls
- **Session isolation** - Uses `--no-workspace` to avoid conflicts

## Future Enhancements

- [ ] Use plugin runtime API for model calls (when available)
- [ ] Learning mode (log patterns without forcing continuation)
- [ ] Per-agent configuration
- [ ] Metrics (detection rate, false positive tracking)
- [ ] Custom prompt templates
- [ ] Multi-model voting (use 2-3 models for consensus)
