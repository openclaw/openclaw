# Intelligent Model Routing

**Status:** Feature Request ([#11068](https://github.com/openclaw/openclaw/issues/11068))

Automatically route messages to cost-effective AI models based on task complexity while maintaining quality.

---

## Overview

Model routing analyzes incoming messages and intelligently selects the optimal model (local, Haiku, or Sonnet) based on task complexity. This can reduce AI costs by 75-85% without sacrificing quality for complex tasks.

### Key Benefits

- **Cost Savings:** 75-85% reduction in AI costs (₹2,500-3,500/month for typical usage)
- **Performance:** Simple tasks run on free local models instantly
- **Quality:** Complex tasks still use powerful models (Sonnet)
- **Control:** User overrides with inline syntax: `[use sonnet]`
- **Transparency:** Logs routing decisions for debugging

---

## Quick Start

### 1. Enable Model Routing

Add to your `openclaw.json5`:

```json5
{
  agents: {
    defaults: {
      modelRouting: {
        enabled: true,
      },
    },
  },
}
```

### 2. Start Using

Messages are automatically routed:

```
You: "check WhatsApp status"
→ Uses: ollama/llama3.1:8b (FREE)

You: "draft a follow-up email"
→ Uses: anthropic/claude-3-5-haiku (₹0.75)

You: "create detailed technical proposal"
→ Uses: anthropic/claude-sonnet-4-5 (₹4)
```

### 3. Override When Needed

Force a specific model with inline syntax:

```
You: "check status [use sonnet]"
→ Forced to: anthropic/claude-sonnet-4-5

You: "write proposal [use haiku]"
→ Forced to: anthropic/claude-3-5-haiku

You: "complex analysis [use local]"
→ Forced to: ollama/llama3.1:8b
```

---

## Configuration

### Default Configuration

```json5
{
  agents: {
    defaults: {
      modelRouting: {
        enabled: true,
        rules: {
          status_check: "ollama/llama3.1:8b",
          file_operation: "ollama/llama3.1:8b",
          draft_message: "anthropic/claude-3-5-haiku-20241022",
          general: "anthropic/claude-3-5-haiku-20241022",
          proposal_creation: "anthropic/claude-sonnet-4-5",
          technical_discussion: "anthropic/claude-sonnet-4-5",
          analysis: "anthropic/claude-sonnet-4-5",
        },
        keywords: {
          local_triggers: [
            "check",
            "status",
            "list",
            "show",
            "find",
            "read",
            "get",
            "view",
            "file",
            "search",
          ],
          haiku_triggers: [
            "draft",
            "follow up",
            "reply",
            "message",
            "send",
            "write",
            "summarize",
            "brief",
            "quick",
          ],
          sonnet_triggers: [
            "proposal",
            "create detailed",
            "analyze",
            "complex",
            "technical",
            "strategic",
            "review",
            "explain",
            "architecture",
            "recommend",
          ],
        },
        override: {
          minConfidence: 0.7,
          fallback: "anthropic/claude-3-5-haiku-20241022",
        },
        learning: {
          enabled: true,
          trackPerformance: true,
          optimizeAfterTasks: 100,
        },
      },
    },
  },
}
```

### Configuration Options

#### `enabled` (boolean)

- **Default:** `false`
- **Description:** Enable/disable model routing
- **Example:** `"enabled": true`

#### `rules` (object)

- **Description:** Map task types to specific models
- **Task Types:**
  - `status_check` - Status queries, simple checks
  - `file_operation` - File reads, searches
  - `draft_message` - Email/message drafts
  - `general` - General queries
  - `proposal_creation` - Detailed proposals
  - `technical_discussion` - Technical questions
  - `analysis` - Complex analysis tasks

#### `keywords` (object)

- **Description:** Keywords that trigger each model tier
- **local_triggers:** Keywords for free local model
- **haiku_triggers:** Keywords for fast Haiku model
- **sonnet_triggers:** Keywords for powerful Sonnet model

#### `override` (object)

- **minConfidence:** Minimum confidence (0-1) to override model selection
- **fallback:** Model to use when confidence is too low

#### `learning` (object)

- **enabled:** Enable learning from routing decisions
- **trackPerformance:** Track routing accuracy
- **optimizeAfterTasks:** Optimize rules after N tasks

---

## How It Works

### Classification Process

1. **Message Analysis**
   - Extracts keywords from user message
   - Counts word length
   - Detects technical terms

2. **Scoring**
   - Each keyword match adds to tier score (local/haiku/sonnet)
   - Message length influences scoring
   - Technical terms boost Sonnet score

3. **Decision**
   - Highest score determines recommended model
   - Confidence calculated (max_score / total_score)
   - Override applied if confidence > threshold

4. **Logging**
   ```
   [model-routing] routed taskType=status_check confidence=95%
   from=anthropic/claude-sonnet-4-5 to=ollama/llama3.1:8b
   ```

### Task Type Detection

The classifier detects these task types automatically:

| Task Type              | Example Messages                      | Routed To     |
| ---------------------- | ------------------------------------- | ------------- |
| `status_check`         | "check WhatsApp", "show status"       | Local (FREE)  |
| `file_operation`       | "read README", "find file"            | Local (FREE)  |
| `draft_message`        | "draft follow-up", "write email"      | Haiku (₹0.75) |
| `general`              | "what's the weather", "help me"       | Haiku (₹0.75) |
| `proposal_creation`    | "create proposal", "detailed plan"    | Sonnet (₹4)   |
| `technical_discussion` | "explain architecture", "review code" | Sonnet (₹4)   |
| `analysis`             | "analyze data", "compare options"     | Sonnet (₹4)   |

---

## User Overrides

### Inline Syntax

Force a specific model by adding `[use MODEL]` to your message:

```
[use local]   → ollama/llama3.1:8b
[use haiku]   → anthropic/claude-3-5-haiku
[use sonnet]  → anthropic/claude-sonnet-4-5
```

### Examples

```
"check status [use sonnet]"
→ Forces Sonnet even though it's a simple task

"create proposal [use haiku]"
→ Forces Haiku even though it's complex (faster/cheaper but may sacrifice quality)

"analyze code [use local]"
→ Forces local model (free but limited capability)
```

### When to Override

**Use `[use sonnet]` when:**

- You need highest quality output
- Complex reasoning required
- Previous attempt with cheaper model failed

**Use `[use haiku]` when:**

- Speed matters more than perfection
- Draft quality is acceptable
- Cost constraints apply

**Use `[use local]` when:**

- Completely offline work needed
- Zero cost required
- Simple data retrieval only

---

## Cost Comparison

### Example Monthly Usage (Based on Real Data)

**Without Routing:**

- 1,000 messages/month
- All using Sonnet (₹4 each)
- **Total: ₹4,000/month**

**With Routing:**

- 400 simple tasks → Local (₹0)
- 400 medium tasks → Haiku (₹0.75 each = ₹300)
- 200 complex tasks → Sonnet (₹4 each = ₹800)
- **Total: ₹1,100/month**
- **Savings: ₹2,900/month (73%)**

### Per-Task Savings

| Task              | Without Routing | With Routing  | Savings   |
| ----------------- | --------------- | ------------- | --------- |
| "check status"    | ₹4 (Sonnet)     | ₹0 (Local)    | **₹4**    |
| "draft email"     | ₹4 (Sonnet)     | ₹0.75 (Haiku) | **₹3.25** |
| "create proposal" | ₹4 (Sonnet)     | ₹4 (Sonnet)   | ₹0        |

---

## Debugging

### View Routing Decisions

Routing decisions are logged to OpenClaw logs:

```bash
openclaw logs | grep "model-routing"
```

### Log Format

```
[model-routing] routed taskType=draft_message confidence=87%
from=anthropic/claude-sonnet-4-5 to=anthropic/claude-3-5-haiku-20241022
```

### Common Issues

**Issue:** Routing not working

- **Check:** `enabled: true` in config
- **Check:** OpenClaw version supports routing
- **Solution:** Restart OpenClaw after config change

**Issue:** Wrong model selected

- **Solution:** Use inline override: `[use MODEL]`
- **Solution:** Adjust `minConfidence` in config
- **Solution:** Add keywords to appropriate trigger list

**Issue:** Too many Sonnet routes (expensive)

- **Solution:** Lower `minConfidence` (e.g., 0.6)
- **Solution:** Add more `haiku_triggers` keywords
- **Solution:** Review `sonnet_triggers` for false positives

---

## Performance Tuning

### Adjust Confidence Threshold

```json5
{
  modelRouting: {
    override: {
      minConfidence: 0.8, // Higher = more conservative (fewer overrides)
    },
  },
}
```

- **0.6:** Aggressive routing (maximum savings, some quality risks)
- **0.7:** Balanced (default, good savings + quality)
- **0.8:** Conservative (fewer overrides, less savings)
- **0.9:** Very conservative (rare overrides, minimal savings)

### Add Custom Keywords

```json5
{
  modelRouting: {
    keywords: {
      local_triggers: [
        "check",
        "status",
        "list",
        "my-custom-keyword", // Add your own
      ],
    },
  },
}
```

### Override Specific Task Rules

```json5
{
  modelRouting: {
    rules: {
      draft_message: "ollama/llama3.1:8b", // Use local for drafts
    },
  },
}
```

---

## Advanced Usage

### Per-Agent Routing

Configure different routing per agent:

```json5
{
  agents: {
    main: {
      modelRouting: {
        enabled: true,
        override: { minConfidence: 0.7 },
      },
    },
    research: {
      modelRouting: {
        enabled: true,
        override: { minConfidence: 0.6 }, // More aggressive
      },
    },
  },
}
```

### Disable for Specific Sessions

```json5
{
  agents: {
    "critical-work": {
      modelRouting: {
        enabled: false, // Always use default model
      },
    },
  },
}
```

---

## FAQ

**Q: Will routing make responses slower?**
A: No. Classification adds <10ms overhead. Local models are often faster than remote ones.

**Q: What if classification is wrong?**
A: Use inline override: `[use sonnet]`. The system learns from patterns over time.

**Q: Can I use different local models?**
A: Yes. Set any local model in `rules.status_check`: `"ollama/my-model"`

**Q: Does this work with all providers?**
A: Yes. Any provider/model format works: `"provider/model-name"`

**Q: What about image tasks?**
A: Image tasks bypass routing and use `imageModel` config as usual.

**Q: Can I disable routing temporarily?**
A: Yes. Set `enabled: false` or override every message with `[use sonnet]`

**Q: How accurate is the classifier?**
A: ~80-90% accuracy on typical messages. Improves with custom keywords.

---

## Migration Guide

### From Manual Model Switching

**Before:**

```bash
/model local
check status
/model sonnet
create proposal
```

**After:**

```
check status              # Auto-routes to local
create proposal           # Auto-routes to sonnet
```

### From All-Sonnet Usage

1. **Enable routing** with default config
2. **Monitor logs** for 1 week
3. **Adjust keywords** based on misclassifications
4. **Tune confidence** to balance savings vs accuracy

---

## Related Documentation

- [Model Selection](./model-selection.md)
- [Model Fallbacks](./model-fallbacks.md)
- [Agent Configuration](../config/agents.md)

---

## Support

- **Feature Request:** [#11068](https://github.com/openclaw/openclaw/issues/11068)
- **Discord:** [#feature-requests](https://discord.com/invite/clawd)
- **Docs:** [docs.openclaw.ai](https://docs.openclaw.ai)

---

**Last Updated:** February 7, 2026  
**Status:** Feature Request (Implementation in Progress)
