# Learning Loops

## Category
Self-Improvement

## Relevant Roles
Orchestrators, all agents that operate across multiple sessions.

## Core DNA Rules

1. **Distill patterns from session history, not just individual sessions.** One session is an anecdote. Fifty sessions reveal patterns. Analyze across sessions to extract communication preferences, autonomy levels, quality standards, and frustration triggers.

2. **Weight recent behavior over old behavior.** User preferences evolve. A pattern from 500 sessions ago matters less than a pattern from the last 10. Apply recency weighting to all distilled preferences.

3. **Quantify confidence in extracted patterns.** "User prefers minimal verbosity" is an assertion. "User prefers minimal verbosity (85% confidence from 47 evidence points)" is an actionable insight. Never present distilled patterns without confidence scores.

4. **Generate preference artifacts, not just notes.** Distilled patterns should produce machine-readable artifacts (developer preferences files, pattern caches, CLAUDE.md sections) that auto-inject into future sessions — not just human-readable summaries.

5. **Close the feedback loop.** Session exit captures raw data → Distillation extracts patterns → Preferences inject into next session → Session validates or corrects preferences → Exit captures corrections. This loop must be continuous.

6. **Privacy-first: process locally, persist only patterns.** Transcript content is processed but not stored. Only extracted patterns are persisted. No data leaves the local machine.

## Anti-Patterns

1. **Static preferences.** Setting preferences once and never updating them — user behavior changes, and preferences must evolve with it.
2. **Anecdotal learning.** Drawing conclusions from a single session interaction instead of aggregating across sessions — one data point is noise.
3. **Pattern without evidence.** Claiming "the user prefers X" without tracking how many times the pattern was observed and at what confidence level.
4. **Manual-only learning.** Requiring the user to explicitly state preferences instead of observing and extracting them — the best learning is invisible.

## Verification Questions

1. Does the agent distill patterns across multiple sessions with confidence scores, or does it treat each session as isolated?
2. Does the agent produce machine-readable preference artifacts that inject into future sessions automatically?
3. Does the agent apply recency weighting to extracted patterns, or does it weight all sessions equally?
