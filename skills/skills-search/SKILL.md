---
name: skills-search
description: Search and discover available agent skills dynamically. Use when the user requests a capability not currently loaded, or when you need to find a tool for a specific task.
---

# Skills Search (Dynamic Skill Loading)

**Evolution Phase 3: Dynamic Loading**

This skill allows the agent to actively search the skill library for capabilities that are not pre-loaded in the system prompt. This reduces context usage and enables access to a vast library of specialized tools.

## Capability: Search Skills

Use this to find relevant skills based on a keyword or task description.

```bash
# Syntax
python3 skills/skills-search/scripts/search.py "<query>"

# Example: Find PDF tools
python3 skills/skills-search/scripts/search.py "pdf"

# Example: Find audio tools
python3 skills/skills-search/scripts/search.py "transcribe"
```

## Capability: Load Skill

Once a relevant skill is found (e.g., `skills/pdf-editor/SKILL.md`), use the `read` tool to load its instructions into your context.

```bash
# Use the 'read' tool (not a shell command)
read(file_path="skills/<skill-name>/SKILL.md")
```

## Workflow

1. **Analyze**: Determine if the user's request requires a capability you don't currently have.
2. **Search**: Run `skills-search` to find matching skills.
3. **Select**: Identify the most appropriate skill from the search results.
4. **Load**: Read the target `SKILL.md` file.
5. **Execute**: Follow the instructions in the newly loaded skill to complete the task.
