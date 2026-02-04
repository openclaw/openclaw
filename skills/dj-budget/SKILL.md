---
name: dj-budget
description: View and manage budget limits for agent workflows.
metadata:
  {
    "openclaw":
      {
        "emoji": "💰",
        "commands":
          [
            { "name": "budget", "description": "View or set budget profile" },
            { "name": "usage", "description": "Show current cost/usage" },
          ],
      },
  }
---

# dj-budget

Manage budget profiles and view usage for agent workflows.

## Commands

### /budget

View current budget profile or switch profiles.

**Usage:**
```
/budget
/budget status
/budget set cheap
/budget set normal
/budget set deep
/budget arm deep
```

### /usage

View current session/daily cost and usage metrics.

**Usage:**
```
/usage
/usage today
/usage week
```

## Budget Profiles

### Cheap (Default for quick tasks)

Minimal resource usage for simple queries:
- Max 10 tool calls
- Max 5 LLM calls
- Max 50k tokens (~$0.10)
- 1 minute timeout
- No subagents
- No browser
- 1 web search allowed

**Best for:** Quick questions, simple lookups, agenda checks.

### Normal (Default)

Balanced limits for typical tasks:
- Max 50 tool calls
- Max 20 LLM calls
- Max 200k tokens (~$1.00)
- 5 minute timeout
- Up to 2 subagents
- No browser
- 5 web searches allowed

**Best for:** Task management, calendar work, research tasks.

### Deep (Requires explicit arming)

Higher caps for complex research:
- Max 200 tool calls
- Max 100 LLM calls
- Max 1M tokens (~$10.00)
- 30 minute timeout
- Up to 10 subagents
- Browser enabled
- 20 web searches allowed

**Best for:** Deep research, complex analysis, multi-step workflows.

⚠️ **Deep mode requires explicit arming:** `/budget arm deep`

## Implementation

### /budget status

```
User: /budget

Cue: 💰 **Budget Status**

Profile: **Normal**
Armed: No

**Current Usage:**
• Tool calls: 5/50 (10%)
• LLM calls: 2/20 (10%)
• Tokens: 15k/200k (7.5%)
• Cost: $0.12/$1.00 (12%)
• Runtime: 45s/5min (15%)

**Limits:**
• Web searches: 5
• Subagents: 2
• Browser: ❌

To change: `/budget set cheap|normal|deep`
```

### /budget set <profile>

```
User: /budget set cheap

Cue: 💰 **Budget profile set to Cheap**

New limits:
• Max 10 tool calls
• Max 5 LLM calls
• Max 50k tokens
• 1 minute timeout
• No subagents, no browser

This applies to your current and future sessions.
```

### /budget arm deep

```
User: /budget arm deep

Cue: ⚠️ **Arming Deep Mode**

This enables higher resource limits:
• Up to 200 tool calls
• Up to 100 LLM calls
• Up to 1M tokens (~$10 max)
• 30 minute timeout
• Browser access enabled

**Reply "confirm" to arm deep mode.**

---

User: confirm

Cue: 💰 **Deep mode armed**

Higher limits now active. Use `/budget status` to monitor usage.
```

### /usage

```
User: /usage

Cue: 📊 **Usage Summary**

**Today:**
• Tokens: 45,230 (input: 38k, output: 7k)
• Cost: $0.47
• Sessions: 12
• Tool calls: 156

**This Week:**
• Total cost: $3.21
• Sessions: 67
• Peak day: Tuesday ($0.89)

**Top Actions by Cost:**
1. Deep research task ($0.89)
2. Podcast prep ($0.42)
3. Weekly review ($0.31)
```

## Enforcement Behavior

When a limit is hit:

1. **Stop gracefully** - Return best partial output
2. **Report the limit** - Tell user which cap was exceeded
3. **Offer escalation** - Ask if user wants to continue in deep mode

Example:

```
Cue: ⚠️ **Budget limit reached**

Limit: maxToolCalls (50)
Current: 50/50

I've completed partial results. To continue with higher limits:
• Reply "continue in deep mode"
• Or adjust limits: `/budget set deep`

**Partial result:**
[... best effort output ...]
```

## Error Loop Detection

If the same error occurs 3 times:

```
Cue: ⚠️ **Error loop detected**

The same error occurred 3 times:
"API rate limit exceeded"

Stopping to prevent runaway resource usage.
Options:
• Wait and retry later
• Check API credentials
• Report issue if persistent
```

## Configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "budget": {
    "defaultProfile": "normal",
    "agentProfiles": {
      "dj-personal": "normal",
      "dj-worksafe": "cheap"
    },
    "profileOverrides": {
      "normal": {
        "maxToolCalls": 75,
        "maxCostUsd": 2.00
      }
    },
    "autoEscalate": false
  }
}
```

## Notes

- Budget limits apply per workflow/request, not globally
- Cost estimates require model pricing in config
- Deep mode resets to normal after session ends
- Use `/usage` to track spending patterns
