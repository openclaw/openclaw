# Recommended Skill Structure

The optimal structure for complex skills separates routing, workflows, and knowledge.

<structure>
```
skill-name/
├── SKILL.md              # Router + essential principles (unavoidable)
├── workflows/            # Step-by-step procedures (how)
│   ├── workflow-a.md
│   ├── workflow-b.md
│   └── ...
└── references/           # Domain knowledge (what)
    ├── reference-a.md
    ├── reference-b.md
    └── ...
```
</structure>

<why_this_works>
## Problems This Solves

**Problem 1: Context gets skipped**
When important principles are in a separate file, Claude may not read them.
**Solution:** Put essential principles directly in SKILL.md. They load automatically.

**Problem 2: Wrong context loaded**
A "build" task loads debugging references. A "debug" task loads build references.
**Solution:** Intake question determines intent → routes to specific workflow → workflow specifies which references to read.

**Problem 3: Monolithic skills are overwhelming**
500+ lines of mixed content makes it hard to find relevant parts.
**Solution:** Small router (SKILL.md) + focused workflows + reference library.

**Problem 4: Procedures mixed with knowledge**
"How to do X" mixed with "What X means" creates confusion.
**Solution:** Workflows are procedures (steps). References are knowledge (patterns, examples).
</why_this_works>

<skill_md_template>
## SKILL.md Template

```markdown
---
name: skill-name
description: What it does and when to use it.
---

<essential_principles>
## How This Skill Works

[Inline principles that apply to ALL workflows. Cannot be skipped.]

### Principle 1: [Name]
[Brief explanation]

### Principle 2: [Name]
[Brief explanation]
</essential_principles>

<intake>
**Ask the user:**

What would you like to do?
1. [Option A]
2. [Option B]
3. [Option C]
4. Something else

**Wait for response before proceeding.**
</intake>

<routing>
| Response | Workflow |
|----------|----------|
| 1, "keyword", "keyword" | `workflows/option-a.md` |
| 2, "keyword", "keyword" | `workflows/option-b.md` |
| 3, "keyword", "keyword" | `workflows/option-c.md` |
| 4, other | Clarify, then select |

**After reading the workflow, follow it exactly.**
</routing>

<reference_index>
All domain knowledge in `references/`:

**Category A:** file-a.md, file-b.md
**Category B:** file-c.md, file-d.md
</reference_index>

<workflows_index>
| Workflow | Purpose |
|----------|---------|
| option-a.md | [What it does] |
| option-b.md | [What it does] |
| option-c.md | [What it does] |
</workflows_index>
```
</skill_md_template>

<workflow_template>
## Workflow Template

```markdown
# Workflow: [Name]

<required_reading>
**Read these reference files NOW:**
1. references/relevant-file.md
2. references/another-file.md
</required_reading>

<process>
## Step 1: [Name]
[What to do]

## Step 2: [Name]
[What to do]

## Step 3: [Name]
[What to do]
</process>

<success_criteria>
This workflow is complete when:
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3
</success_criteria>
```
</workflow_template>

<when_to_use_this_pattern>
## When to Use This Pattern

**Use router + workflows + references when:**
- Multiple distinct workflows (build vs debug vs ship)
- Different workflows need different references
- Essential principles must not be skipped
- Skill has grown beyond 200 lines

**Use simple single-file skill when:**
- One workflow
- Small reference set
- Under 200 lines total
- No essential principles to enforce
</when_to_use_this_pattern>

<key_insight>
## The Key Insight

**SKILL.md is always loaded. Use this guarantee.**

Put unavoidable content in SKILL.md:
- Essential principles
- Intake question
- Routing logic

Put workflow-specific content in workflows/:
- Step-by-step procedures
- Required references for that workflow
- Success criteria for that workflow

Put reusable knowledge in references/:
- Patterns and examples
- Technical details
- Domain expertise
</key_insight>
