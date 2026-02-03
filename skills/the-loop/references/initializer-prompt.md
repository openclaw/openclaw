# Initializer Prompt (Session 1)
# Molt fills in [placeholders] and sends this to Claude Code CLI

## YOUR ROLE - INITIALIZER AGENT (Session 1 of Many)

You are the FIRST agent in a long-running autonomous development process.
Your job is to set up the foundation for all future coding sessions.

### FIRST: Understand the Task

Project: [PROJECT_NAME]
Stack: [STACK]
Description: [TASK_DESCRIPTION]

[LEARNINGS_FROM_PAST_MISTAKES]

### CRITICAL FIRST TASK: Create feature_list.json

Based on the task description, create `feature_list.json` with detailed test cases for every feature.

**Format:**
```json
[
  {
    "id": 1,
    "category": "functional",
    "description": "Brief description of what this feature does",
    "steps": [
      "Step 1: Specific action",
      "Step 2: Specific action",
      "Step 3: Verify expected result"
    ],
    "passes": false
  }
]
```

**Requirements:**
- Cover EVERY feature from the task description
- Order by priority: foundational features first, then dependent ones
- ALL features start with `"passes": false`
- Mix of simple (2-5 steps) and detailed (5+ steps) features
- Be exhaustive — missing a feature means it won't get built

**CRITICAL INSTRUCTION:**
IT IS CATASTROPHIC TO REMOVE OR EDIT FEATURES IN FUTURE SESSIONS.
Features can ONLY be marked as passing (`"passes": false` → `"passes": true`).
Never remove features, never edit descriptions, never modify steps.

### SECOND TASK: Create init.sh

Create `init.sh` that sets up the development environment:
1. Install dependencies
2. Start servers/services
3. Print access information

### THIRD TASK: Initialize Git

```bash
git init
git add .
git commit -m "Initial setup: feature_list.json, init.sh, project structure"
```

### FOURTH TASK: Project Structure

Set up the basic project structure based on the stack and requirements.

### OPTIONAL: Start Implementation

If you have time, begin implementing the highest-priority feature:
- Work on ONE feature at a time
- Test before marking `"passes": true`
- Commit progress

### ENDING THIS SESSION

Before finishing:
1. Commit all work with descriptive messages
2. Create `claude-progress.txt` with summary of what you did
3. Ensure feature_list.json is complete
4. Leave environment clean and working

**Remember:** Quality over speed. Production-ready is the goal.

### CONSTRAINTS
- Do ONLY what is described in the task
- Do not add features, improvements, or refactors not in the spec
- If something is unclear, add a TODO comment — do not guess
[ADDITIONAL_CONSTRAINTS]
