---
summary: "Multi-model collaboration using the Society of Minds pattern"
title: Society of Minds
read_when: "You want multiple AI models to collaborate on complex problems"
status: active
---

# Society of Minds

The Society of Minds feature enables multiple AI models (Claude, GPT-4, Gemini, Grok) to work together on the same problem, then synthesizes their results into a unified response.

## Overview

Society of Minds coordinates multiple AI models working on the same task through task distribution, collaboration, and result synthesis.

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

## See Also

- [Sub-agents documentation](/tools/subagents)
- [Multi-agent routing](/concepts/multi-agent)
