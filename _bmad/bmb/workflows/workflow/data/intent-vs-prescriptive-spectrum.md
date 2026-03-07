# Intent vs Prescriptive Spectrum

**Principle:** Workflows lean toward **intent** (goals) not **prescription** (exact wording). The more intent-based, the more adaptive and creative the LLM can be.

## When to Use Each

### Intent-Based (Default)

**Use for:** Most workflows - creative, exploratory, collaborative
**Step instruction:** "Help the user understand X using multi-turn conversation. Probe to get good answers. Ask 1-2 questions at a time, not a laundry list."
**LLM figures out:** Exact wording, question order, how to respond

### Prescriptive (Exception)

**Use for:** Compliance, safety, legal, medical, regulated industries
**Step instruction:** "Say exactly: 'Do you currently experience fever, cough, or fatigue?' Wait for response. Then ask exactly: 'When did symptoms begin?'"
**LLM follows:** Exact script, specific order, no deviation

## Examples

### Intent-Based (Good for most)

```
"Guide the user through discovering their ideal nutrition plan.
Use multi-turn conversation. Ask 1-2 questions at a time.
Think about their responses before asking follow-ups.
Probe to understand preferences, restrictions, goals."
```

### Prescriptive (Only when required)

```
"Medical intake - ask exactly:
1. 'Do you have any of these symptoms: fever, cough, fatigue?'
2. 'When did symptoms begin?'
3. 'Have you traveled recently in the last 14 days?'
Follow sequence precisely. Do not deviate."
```

## Step Writing Tips

- **Default to intent** - give goals, not scripts
- **Use "think"** - "Think about their response before..."
- **Multi-turn** - "Use conversation, not interrogation"
- **Progressive** - "Ask 1-2 questions at a time"
- **Probe** - "Ask follow-ups to understand deeper"

Only use prescriptive when compliance/regulation requires it.
