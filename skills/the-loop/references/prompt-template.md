# Prompt Template for Claude Code

Use this structure when composing prompts for Claude Code sub-agent.

```
## Context
Project: [name]
Stack: [language, frameworks, DB]
Architecture: [brief description]
Current state: [what exists, what's working]

## Task
Implement ONE feature: [description from feature-list]

Steps:
1. [specific step]
2. [specific step]
3. [specific step]

## Files
Read: [list of files to understand]
Create/Edit: [list of files to change]
DO NOT TOUCH: [list of files to leave alone]

## Constraints
- Code style: [project conventions]
- DO NOT: [list of things to avoid]
- Do ONLY what is described above
- Do not add features, improvements, or refactors not listed in the task
- If something is unclear, stop and ask — do not guess

## Learnings (from past mistakes)
- [relevant learning 1]
- [relevant learning 2]

## Testing
After changes, run: [test commands]
Verify that: [checklist]
Commit with descriptive message: "[feature]: [what was done]"
```

## Notes

- Always fill in learnings — use `memory_search` to find relevant ones
- Keep constraints specific, not generic
- "DO NOT TOUCH" is critical — prevents scope creep
- One feature per prompt, never batch
- If no learnings found, omit the section (don't write "none")
