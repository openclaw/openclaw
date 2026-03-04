---
name: retrace
description: Retrace the steps of a completed task and produce either a reusable skill or a how-to guide. Use when the user says things like "make a skill from what we just did", "create a how-to from this session", "retrace the steps", "document what we did", "turn this into a guide", "save this workflow as a skill", or wants to capture and replay a previous task's process.
---

# Retrace

Review a session's history (current or past) and distill it into one of two outputs:

1. **Skill** — a reusable SKILL.md package (uses the `skill-creator` skill conventions)
2. **How-to guide** — a markdown guide with extracted helper scripts

## Workflow

### 1. Identify the session

If the user wants to retrace the **current** session, use the conversation history already in context.

If the user wants to retrace a **past** session, locate the JSONL log:

```bash
# List recent sessions (newest first)
for f in ~/.openclaw/agents/<agentId>/sessions/*.jsonl; do
  ts=$(head -1 "$f" | jq -r '.timestamp' | cut -dT -f1)
  sz=$(ls -lh "$f" | awk '{print $5}')
  echo "$ts  $sz  $(basename "$f")"
done | sort -r | head -20
```

Help the user pick one by date/size, or search by keyword:

```bash
rg -l "keyword" ~/.openclaw/agents/<agentId>/sessions/*.jsonl
```

### 2. Extract the steps

Run the helper script to get a structured summary:

```bash
scripts/extract_steps.sh <session.jsonl>
```

For JSON output (useful for programmatic processing):

```bash
scripts/extract_steps.sh <session.jsonl> --format json
```

For the current session, manually review the conversation history in context and identify:

- What the user asked for (goals)
- What decisions were made and why
- What tools/commands were used
- What files were created or modified
- What the final outcome was

### 3. Ask the user for output format

Present two options:

- **Skill** — a reusable, self-contained skill package that another agent can use to repeat the same type of task
- **How-to guide** — a step-by-step markdown document (with helper scripts) that a human or agent can follow

### 4a. Generate a Skill

Follow the `skill-creator` conventions. The generated skill should:

1. Have a clear `name` and `description` in frontmatter (the description must include trigger phrases)
2. Distill the session's workflow into reusable instructions (not a transcript replay)
3. Generalize — replace session-specific values (paths, names, URLs) with parameters or placeholders
4. Include `scripts/` for any bash/python that was used repeatedly or would be rewritten each time
5. Include `references/` for domain knowledge discovered during the session
6. Keep SKILL.md under 500 lines; split into references if longer

Structure:

```
<skill-name>/
├── SKILL.md
├── scripts/       (reusable commands/automation extracted from the session)
└── references/    (domain knowledge, API docs, schemas discovered)
```

Write the skill to `~/.openclaw/skills/<skill-name>/` (user workspace) so it's immediately available.

After writing, validate:

```bash
python3 <openclaw-repo>/skills/skill-creator/scripts/quick_validate.py ~/.openclaw/skills/<skill-name>
```

### 4b. Generate a How-To Guide

Produce a markdown file and optional helper scripts. See `references/guide-template.md` for the template structure.

Key principles:

- **Goal-first**: Start with what the guide accomplishes
- **Prerequisites**: List required tools, access, knowledge
- **Numbered steps**: Each step = one action + expected outcome
- **Extract scripts**: Any multi-line command used during the task becomes a standalone script in a `scripts/` directory next to the guide
- **Generalize**: Replace session-specific values with `<placeholders>` and explain what to substitute
- **Verify steps**: Include verification/check commands after critical steps
- **Troubleshooting**: Add a section for errors encountered and how they were resolved during the session

Write the guide to a path the user specifies, or default to `./how-to-<topic>.md`.

### 5. Review with the user

Present the generated output and ask if anything should be adjusted:

- Missing steps or context?
- Too specific or too general?
- Scripts that should be added or removed?
- For skills: trigger phrases that should be added to the description?
