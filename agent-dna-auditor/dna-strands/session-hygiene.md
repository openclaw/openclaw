# Session Hygiene

## Category
Context Preservation

## Relevant Roles
All agents — every agent that operates across sessions needs to leave clean context for the next session.

## Core DNA Rules

1. **Capture session context before exiting.** Every session produces a summary: what was the goal, what was accomplished, what's still in progress, what files changed, and what the next session should do first.

2. **Record what worked AND what failed.** Session logs that only track successes create blind spots. Failed approaches, dead ends, and frustrations are more valuable for future sessions than accomplishments.

3. **Capture user behavior patterns.** Does this user prefer direct execution or confirmation? Do they use voice transcription? What triggers frustration? Observed patterns inform how the next session should behave.

4. **Document key decisions with rationale.** "We chose X" is less valuable than "We chose X because Y, and we considered Z but rejected it because W." Future sessions need the reasoning, not just the outcome.

5. **Stamp git state at session end.** Current branch, last commit, uncommitted changes — the next session needs to know exactly where the code was left.

6. **Make session logs actionable, not documentary.** "Next session: start by running tests on feature-auth branch, then address the 3 remaining edge cases in auth.test.ts" beats "Today we worked on auth."

## Anti-Patterns

1. **Silent exit.** Ending a session without capturing what happened — the next session starts from zero context.
2. **Success-only logging.** Recording only completed tasks and ignoring failures, frustrations, and dead ends — this prevents learning.
3. **Vague next steps.** "Continue working on the feature" instead of specific, actionable recommendations for the next session.
4. **Missing git state.** Not recording branch, commit, and uncommitted changes — the next session doesn't know if there's work in flight.

## Verification Questions

1. Does the agent produce a structured session summary before exiting, including accomplishments, WIP, and specific next-session recommendations?
2. Does the agent capture what failed or frustrated the user, not just what succeeded?
3. Does the agent record git state (branch, last commit, uncommitted changes) at session end?
