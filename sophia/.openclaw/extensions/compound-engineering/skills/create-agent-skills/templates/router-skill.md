---
name: {{SKILL_NAME}}
description: {{What it does}} Use when {{trigger conditions}}.
---

<essential_principles>
## {{Core Concept}}

{{Principles that ALWAYS apply, regardless of which workflow runs}}

### 1. {{First principle}}
{{Explanation}}

### 2. {{Second principle}}
{{Explanation}}

### 3. {{Third principle}}
{{Explanation}}
</essential_principles>

<intake>
**Ask the user:**

What would you like to do?
1. {{First option}}
2. {{Second option}}
3. {{Third option}}

**Wait for response before proceeding.**
</intake>

<routing>
| Response | Workflow |
|----------|----------|
| 1, "{{keywords}}" | `workflows/{{first-workflow}}.md` |
| 2, "{{keywords}}" | `workflows/{{second-workflow}}.md` |
| 3, "{{keywords}}" | `workflows/{{third-workflow}}.md` |

**After reading the workflow, follow it exactly.**
</routing>

<quick_reference>
## {{Skill Name}} Quick Reference

{{Brief reference information always useful to have visible}}
</quick_reference>

<reference_index>
## Domain Knowledge

All in `references/`:
- {{reference-1.md}} - {{purpose}}
- {{reference-2.md}} - {{purpose}}
</reference_index>

<workflows_index>
## Workflows

All in `workflows/`:

| Workflow | Purpose |
|----------|---------|
| {{first-workflow}}.md | {{purpose}} |
| {{second-workflow}}.md | {{purpose}} |
| {{third-workflow}}.md | {{purpose}} |
</workflows_index>

<success_criteria>
A well-executed {{skill name}}:
- {{First criterion}}
- {{Second criterion}}
- {{Third criterion}}
</success_criteria>
