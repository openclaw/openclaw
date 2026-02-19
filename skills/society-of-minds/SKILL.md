---
name: society-of-minds
description: "Multi-model collaboration using the Society of Minds pattern. Coordinate multiple AI models (Claude, GPT-4, Gemini, Grok) working together on complex problems, then synthesize their results."
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "requires": { "config": { "agents.defaults.societyOfMinds.enabled": true } },
      },
  }
---

# Society of Minds Skill

Use the `society_of_minds` tool to coordinate multiple AI models working together on complex problems. This implements the "Society of Minds" pattern where different models collaborate to provide better solutions than any single model alone.

## When to Use

✅ **USE this skill when:**

- Solving complex problems that benefit from multiple perspectives
- Need high-confidence answers (wisdom of the crowd)
- Task requires different model strengths (coding + research + creativity)
- Want to compare approaches from different models
- Building autonomous systems that need robust decision-making

❌ **DON'T use this skill when:**

- Simple, straightforward tasks (single model is sufficient)
- Cost-sensitive operations (uses multiple model calls)
- Time-sensitive tasks (parallel mode is faster but still multiple calls)
- Tasks that don't benefit from multiple perspectives

## How It Works

The Society of Minds pattern works by:

1. **Task Distribution**: Routes the task to appropriate models based on task characteristics
2. **Collaboration**: Models work in parallel, sequential, or debate mode
3. **Synthesis**: Results from all models are combined into a unified response

### Strategies

- **parallel** (default): All models work simultaneously, fastest but uses most tokens
- **sequential**: Models work one after another, each can build on previous results
- **debate**: Models provide initial answers, then respond to each other before final synthesis

## Configuration

Enable in `~/.openclaw/openclaw.json`:

```json5
{
  agents: {
    defaults: {
      societyOfMinds: {
        enabled: true,
        models: ["claude-opus-4", "gpt-4", "gemini-pro", "grok-beta"],
        strategy: "parallel",
        synthesisModel: "claude-opus-4",
        maxConcurrent: 4,
      },
    },
  },
}
```

## Usage Examples

### Basic Usage

```typescript
// Simple parallel execution
society_of_minds({
  task: "Analyze the pros and cons of autonomous weapons systems",
  strategy: "parallel",
});
```

### Sequential Mode

```typescript
// Models build on each other's work
society_of_minds({
  task: "Design a scalable architecture for a news aggregator",
  strategy: "sequential",
  label: "Architecture Design",
});
```

### Debate Mode

```typescript
// Models discuss before final answer
society_of_minds({
  task: "What are the ethical implications of AI agents running businesses?",
  strategy: "debate",
  models: ["claude-opus-4", "gpt-4"],
});
```

### Custom Model Selection

```typescript
// Use specific models for the task
society_of_minds({
  task: "Research latest AI developments and summarize",
  models: ["grok-beta", "gemini-pro"], // Grok for real-time news, Gemini for research
  synthesisModel: "claude-opus-4",
});
```

## Model Selection Logic

The router automatically selects models based on task content:

- **Coding tasks**: Prefers Claude and GPT-4
- **Research tasks**: Prefers Grok (X/Twitter integration) and Gemini (web search)
- **Creative tasks**: Prefers Claude and GPT-4
- **Math tasks**: Prefers Claude and Gemini

You can override this by specifying `models` explicitly.

## Best Practices

1. **Use for complex problems**: Simple tasks don't need multiple models
2. **Consider cost**: Each model call costs tokens/money
3. **Choose strategy wisely**:
   - `parallel` for speed and independent perspectives
   - `sequential` when models should build on each other
   - `debate` for controversial or nuanced topics
4. **Monitor results**: Check which models provided the best insights
5. **Synthesis model**: Choose a strong reasoning model (Claude recommended)

## Integration with Sub-agents

Society of Minds uses OpenClaw's sub-agent infrastructure. Each model runs as a sub-agent, and results are announced back when complete. This provides:

- Isolation between model runs
- Proper session management
- Token/cost tracking per model
- Error handling per model

## Example: News Aggregation Analysis

```typescript
// Use Society of Minds to analyze news from multiple perspectives
const result = await society_of_minds({
  task: `Analyze these news articles and rank them by importance for AI/tech audience:
  
  ${articles.map(a => `- ${a.title}: ${a.url}`).join('\n')}`,
  strategy: "parallel",
  models: ["claude-opus-4", "gpt-4", "gemini-pro"],
  synthesisModel: "claude-opus-4",
});

// Result includes:
// - synthesizedResult: Unified analysis
// - modelResults: Individual model outputs
// - totalTokens: Aggregate token usage
// - totalCost: Aggregate cost
```

## Limitations

- Requires multiple model API keys configured
- Higher token/cost usage than single model
- Results announced asynchronously (sub-agents)
- Not suitable for real-time interactive tasks

## See Also

- `sessions_spawn` - Spawn individual sub-agents
- `subagents` - Manage sub-agent runs
- Multi-agent routing documentation
