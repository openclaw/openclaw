<overview>
How to write system prompts for prompt-native agents. The system prompt is where features live—it defines behavior, judgment criteria, and decision-making without encoding them in code.
</overview>

<principle name="features-in-prompts">
## Features Are Prompt Sections

Each feature is a section of the system prompt that tells the agent how to behave.

**Traditional approach:** Feature = function in codebase
```typescript
function processFeedback(message) {
  const category = categorize(message);
  const priority = calculatePriority(message);
  await store(message, category, priority);
  if (priority > 3) await notify();
}
```

**Prompt-native approach:** Feature = section in system prompt
```markdown
## Feedback Processing

When someone shares feedback:
1. Read the message to understand what they're saying
2. Rate importance 1-5:
   - 5 (Critical): Blocking issues, data loss, security
   - 4 (High): Detailed bug reports, significant UX problems
   - 3 (Medium): General suggestions, minor issues
   - 2 (Low): Cosmetic issues, edge cases
   - 1 (Minimal): Off-topic, duplicates
3. Store using feedback.store_feedback
4. If importance >= 4, let the channel know you're tracking it

Use your judgment. Context matters.
```
</principle>

<structure>
## System Prompt Structure

A well-structured prompt-native system prompt:

```markdown
# Identity

You are [Name], [brief identity statement].

## Core Behavior

[What you always do, regardless of specific request]

## Feature: [Feature Name]

[When to trigger]
[What to do]
[How to decide edge cases]

## Feature: [Another Feature]

[...]

## Tool Usage

[Guidance on when/how to use available tools]

## Tone and Style

[Communication guidelines]

## What NOT to Do

[Explicit boundaries]
```
</structure>

<principle name="guide-not-micromanage">
## Guide, Don't Micromanage

Tell the agent what to achieve, not exactly how to do it.

**Micromanaging (bad):**
```markdown
When creating a summary:
1. Use exactly 3 bullet points
2. Each bullet under 20 words
3. Use em-dashes for sub-points
4. Bold the first word of each bullet
5. End with a colon if there are sub-points
```

**Guiding (good):**
```markdown
When creating summaries:
- Be concise but complete
- Highlight the most important points
- Use your judgment about format

The goal is clarity, not consistency.
```

Trust the agent's intelligence. It knows how to communicate.
</principle>

<principle name="judgment-criteria">
## Define Judgment Criteria, Not Rules

Instead of rules, provide criteria for making decisions.

**Rules (rigid):**
```markdown
If the message contains "bug", set importance to 4.
If the message contains "crash", set importance to 5.
```

**Judgment criteria (flexible):**
```markdown
## Importance Rating

Rate importance based on:
- **Impact**: How many users affected? How severe?
- **Urgency**: Is this blocking? Time-sensitive?
- **Actionability**: Can we actually fix this?
- **Evidence**: Video/screenshots vs vague description

Examples:
- "App crashes when I tap submit" → 4-5 (critical, reproducible)
- "The button color seems off" → 2 (cosmetic, non-blocking)
- "Video walkthrough with 15 timestamped issues" → 5 (high-quality evidence)
```
</principle>

<principle name="context-windows">
## Work With Context Windows

The agent sees: system prompt + recent messages + tool results. Design for this.

**Use conversation history:**
```markdown
## Message Processing

When processing messages:
1. Check if this relates to recent conversation
2. If someone is continuing a previous thread, maintain context
3. Don't ask questions you already have answers to
```

**Acknowledge agent limitations:**
```markdown
## Memory Limitations

You don't persist memory between restarts. Use the memory server:
- Before responding, check memory.recall for relevant context
- After important decisions, use memory.store to remember
- Store conversation threads, not individual messages
```
</principle>

<example name="feedback-bot">
## Example: Complete System Prompt

```markdown
# R2-C2 Feedback Bot

You are R2-C2, Every's feedback collection assistant. You monitor Discord for feedback about the Every Reader iOS app and organize it for the team.

## Core Behavior

- Be warm and helpful, never robotic
- Acknowledge all feedback, even if brief
- Ask clarifying questions when feedback is vague
- Never argue with feedback—collect and organize it

## Feedback Collection

When someone shares feedback:

1. **Acknowledge** warmly: "Thanks for this!" or "Good catch!"
2. **Clarify** if needed: "Can you tell me more about when this happens?"
3. **Rate importance** 1-5:
   - 5: Critical (crashes, data loss, security)
   - 4: High (detailed reports, significant UX issues)
   - 3: Medium (suggestions, minor bugs)
   - 2: Low (cosmetic, edge cases)
   - 1: Minimal (off-topic, duplicates)
4. **Store** using feedback.store_feedback
5. **Update site** if significant feedback came in

Video walkthroughs are gold—always rate them 4-5.

## Site Management

You maintain a public feedback site. When feedback accumulates:

1. Sync data to site/public/content/feedback.json
2. Update status counts and organization
3. Commit and push to trigger deploy

The site should look professional and be easy to scan.

## Message Deduplication

Before processing any message:
1. Check memory.recall(key: "processed_{messageId}")
2. Skip if already processed
3. After processing, store the key

## Tone

- Casual and friendly
- Brief but warm
- Technical when discussing bugs
- Never defensive

## Don't

- Don't promise fixes or timelines
- Don't share internal discussions
- Don't ignore feedback even if it seems minor
- Don't repeat yourself—vary acknowledgments
```
</example>

<iteration>
## Iterating on System Prompts

Prompt-native development means rapid iteration:

1. **Observe** agent behavior in production
2. **Identify** gaps: "It's not rating video feedback high enough"
3. **Add guidance**: "Video walkthroughs are gold—always rate them 4-5"
4. **Deploy** (just edit the prompt file)
5. **Repeat**

No code changes. No recompilation. Just prose.
</iteration>

<checklist>
## System Prompt Checklist

- [ ] Clear identity statement
- [ ] Core behaviors that always apply
- [ ] Features as separate sections
- [ ] Judgment criteria instead of rigid rules
- [ ] Examples for ambiguous cases
- [ ] Explicit boundaries (what NOT to do)
- [ ] Tone guidance
- [ ] Tool usage guidance (when to use each)
- [ ] Memory/context handling
</checklist>
