# The Builders Podcast Script Generation v2

Generate a complete podcast script with section markers and citation integration.

## The Hosts

**Maya Chen (Person1):**
- Former software engineer, founded and sold a B2B SaaS startup
- Lens: "How does this actually work?" - technical, mechanical, architectural
- Skeptical of hype, wants specifics and numbers
- Phrases: "Wait, slow down.", "Show me the numbers.", "I had to read this three times.", "That's actually clever because..."
- NEVER says: "From a strategic perspective", "The market opportunity"

**James Porter (Person2):**
- Former venture capitalist, studied business history
- Lens: "What's the business model?" - strategy, markets, competitive dynamics
- Synthesizer, pattern matcher, historical parallels
- Phrases: "For context...", "This is the classic [X] playbook.", "The lesson here is...", "What a story."
- NEVER says: "Let me explain the architecture", "The API design"

## Citation Integration

Hosts naturally reference sources:
- "According to their Series B deck..."
- "There's this great interview where [Founder] said..."
- "The SEC filing actually shows..."
- "I found this quote from [Year]..."

## Episode Structure

### SECTION 1: HOOK (Turns 1-15, ~3-4 min)

Use this hook:
{{SELECTED_HOOK}}

Guidelines:
- Open with the hook, let it land
- Person2 reacts with genuine surprise/curiosity
- Establish central question of episode
- Tease what's coming without spoiling
- End section with clear transition to origin

### SECTION 2: ORIGIN STORY (Turns 16-45, ~6-7 min)

Cover:
- Who are the founders? Make them human
- What was the genesis moment?
- What was the market context?
- What was their early bet/hypothesis?
- First signs of traction or failure

Guidelines:
- Maya explores technical origins
- James provides market/strategy context
- Include specific dates, amounts, details
- At least one "I didn't know that" moment

### SECTION 3: KEY INFLECTION #1 (Turns 46-70, ~5 min)

Cover:
- What decision did they face?
- What alternatives existed?
- What did they risk?
- How did it play out?

Guidelines:
- Build tension before revealing outcome
- Explore the "what if they'd done X instead?"
- Use specific numbers for before/after
- Include a quote from the time

### SECTION 4: KEY INFLECTION #2 (Turns 71-90, ~4 min)

Cover:
- New challenge or opportunity
- How they adapted/pivoted
- Key insight they gained

Guidelines:
- Connect to first inflection
- Show evolution of thinking
- Maya: technical implications
- James: strategic implications

### SECTION 5: MESSY MIDDLE (Turns 91-105, ~3 min)

Cover:
- Near-death moment(s)
- Internal conflicts
- What almost broke them

Guidelines:
- Don't glorify - show real struggle
- Include specific stakes ("6 months of runway")
- One host can play devil's advocate

### SECTION 6: NOW (Turns 106-120, ~3 min)

Cover:
- Current position and metrics
- Competitive landscape
- Open questions

Guidelines:
- Timeless framing (position, not news)
- Acknowledge uncertainty about future
- Set up takeaways

### SECTION 7: TAKEAWAYS (Turns 121-130, ~2-3 min)

Cover:
- Key lesson(s)
- Framework or principle
- Final memorable thought

Guidelines:
- Both hosts contribute insights
- Connect back to hook/central question
- End with forward-looking thought
- Final line should resonate

## Format Rules

1. Use `<Person1>` and `<Person2>` XML tags
2. Each turn: 2-5 sentences (conversation, not monologue)
3. Add section markers: `<!-- SECTION X: NAME -->`
4. Include discovery moments in every section
5. NO news references - timeless only
6. Use SPECIFIC facts from research
7. Both hosts should learn during conversation
8. Minimum 130 turns total

## Section Marker Format

```
<!-- SECTION 1: HOOK -->
<Person1>The email arrived at 2 AM...</Person1>
...

<!-- SECTION 2: ORIGIN -->
<Person1>Okay, so let's go back to the beginning...</Person1>
...
```

## Research Material

{{RESEARCH}}

---

## Selected Hook

{{HOOK}}

---

Generate the complete script now. Start with `<!-- SECTION 1: HOOK -->` followed by `<Person1>`.
