# MABOS Model Selection Hierarchy

Maps to the ontology's operational levels (strategic → tactical → operational).

## Tier 1 — Strategic

**Use for:** Main session, complex decisions, architecture, stakeholder interactions
| Model | Alias | Provider |
|-------|-------|----------|
| claude-opus-4-6 | `opus` | Anthropic |

## Tier 2 — Tactical

**Use for:** Sub-agents, C-suite agent reasoning, analysis, planning
| Model | Alias | Provider |
|-------|-------|----------|
| claude-sonnet-4 | `sonnet` | Anthropic |
| gemini-2.5-pro | `gemini-pro` | Google |
| gpt-4o | `gpt4o` | OpenAI |

## Tier 3 — Operational

**Use for:** Routine tasks, data processing, simple queries, high-volume operations
| Model | Alias | Provider |
|-------|-------|----------|
| claude-haiku-3.5 | `haiku` | Anthropic |
| gpt-4o-mini | `gpt4o-mini` | OpenAI |
| gemini-2.0-flash | `gemini-flash` | Google |

## Tier 4 — Specialized

**Use for:** Specific workloads via OpenRouter
| Model | Alias | Provider | Best For |
|-------|-------|----------|----------|
| deepseek-r1 | `deepseek` | OpenRouter | Deep reasoning, math, code analysis |
| llama-4-maverick | `llama` | OpenRouter | Open-weight, high throughput |
| mistral-large | `mistral` | OpenRouter | European compliance, multilingual |

## Agent → Model Mapping (recommended)

| Agent Role            | Default Model     | Rationale                          |
| --------------------- | ----------------- | ---------------------------------- |
| Stakeholder (Kingler) | opus              | Highest quality for principal      |
| CEO Agent             | sonnet            | Strategic reasoning at lower cost  |
| CFO Agent             | sonnet            | Financial analysis needs precision |
| CTO Agent             | sonnet / deepseek | Code-heavy decisions               |
| CMO Agent             | haiku             | Content generation, high volume    |
| COO Agent             | haiku             | Operational tasks, routine         |
| HR Agent              | haiku             | Routine contractor management      |
| Legal Agent           | sonnet            | Needs precision for compliance     |
| Strategy Agent        | gemini-pro        | Long context, research-heavy       |
| Knowledge Agent       | gemini-flash      | Fast ontology queries              |

## Usage in OpenClaw

```bash
# Override model for a session
/model sonnet

# Spawn sub-agent with specific model
sessions_spawn(task="...", model="haiku")

# Cron job with model override
cron add --payload.model="gemini-flash"
```

## Cost Optimization Rules

1. **Default to the lowest tier that can handle the task**
2. **Escalate up** when task complexity requires it
3. **Never use Opus** for routine/operational tasks
4. **Use Haiku/Flash** for high-frequency agent cycles (BDI loops, metrics collection)
5. **Use Sonnet/Gemini Pro** for planning, analysis, and decision preparation
6. **Reserve Opus** for stakeholder-facing outputs and architectural decisions
