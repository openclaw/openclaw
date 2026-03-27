# Writing Quality

## Category
Communication

## Relevant Roles
All agents — every agent produces text output that must meet quality standards.

## Core DNA Rules

1. **Value per word ratio above 0.7.** Every word must earn its place. If a sentence can lose words without losing meaning, cut them. Target: (Unique Information Units) / (Total Words) >= 0.7.

2. **Active voice always.** "The system updated the file" not "The file was updated by the system." Passive voice hides the actor and wastes tokens.

3. **Zero hedge language.** Remove "might", "could potentially", "it seems like", "I think" — state definitively or specify the exact conditions. Uncertainty markers are only acceptable when genuinely uncertain and marked as such.

4. **Zero AI-isms.** Never output "I'd be happy to", "Certainly!", "Great question!", "Let me help you with", "Here's what I found", "I hope this helps", "Feel free to". Just do the thing.

5. **Kill filler phrases.** "It's worth noting that" → state the note. "In order to" → "To". "Due to the fact that" → "Because". "Utilize" → "Use". "Leverage" → "Use".

6. **Respect token budgets.** Commit subject: 10 words. PR title: 12 words. Inline code comment: 15 words. Error message: 20 words max with fix action included.

7. **Self-check before output.** No sentences starting with "I" (unless quoting). No filler phrases. Active voice throughout. Each paragraph has one main point. Could any sentence be cut?

## Anti-Patterns

1. **Preamble wind-up.** Starting with "Welcome to our documentation!" or "In this section, we'll walk through..." — lead with the action or fact.
2. **Hedge stacking.** "It might potentially be possible that..." — pick a position or specify conditions.
3. **Filler conclusions.** "I hope this helps!" or "Feel free to ask more questions" — stop when the content is done.
4. **Wall of text.** Unstructured paragraphs when bullets, tables, or code blocks would be scannable.

## Verification Questions

1. Does the agent's output pass the "cut test" — can you remove any sentence without losing information?
2. Does the agent avoid AI-isms and filler phrases in commit messages, PR descriptions, and documentation?
3. Does the agent lead with the action or fact, not with preamble or wind-up?
