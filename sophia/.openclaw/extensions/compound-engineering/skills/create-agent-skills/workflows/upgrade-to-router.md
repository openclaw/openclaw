# Workflow: Upgrade Skill to Router Pattern

<required_reading>
**Read these reference files NOW:**
1. references/recommended-structure.md
2. references/skill-structure.md
</required_reading>

<process>
## Step 1: Select the Skill

```bash
ls ~/.openclaw/skills/
```

Present numbered list, ask: "Which skill should be upgraded to the router pattern?"

## Step 2: Verify It Needs Upgrading

Read the skill:
```bash
cat ~/.openclaw/skills/{skill-name}/SKILL.md
ls ~/.openclaw/skills/{skill-name}/
```

**Already a router?** (has workflows/ and intake question)
→ Tell user it's already using router pattern, offer to add workflows instead

**Simple skill that should stay simple?** (under 200 lines, single workflow)
→ Explain that router pattern may be overkill, ask if they want to proceed anyway

**Good candidate for upgrade:**
- Over 200 lines
- Multiple distinct use cases
- Essential principles that shouldn't be skipped
- Growing complexity

## Step 3: Identify Components

Analyze the current skill and identify:

1. **Essential principles** - Rules that apply to ALL use cases
2. **Distinct workflows** - Different things a user might want to do
3. **Reusable knowledge** - Patterns, examples, technical details

Present findings:
```
## Analysis

**Essential principles I found:**
- [Principle 1]
- [Principle 2]

**Distinct workflows I identified:**
- [Workflow A]: [description]
- [Workflow B]: [description]

**Knowledge that could be references:**
- [Reference topic 1]
- [Reference topic 2]
```

Ask: "Does this breakdown look right? Any adjustments?"

## Step 4: Create Directory Structure

```bash
mkdir -p ~/.openclaw/skills/{skill-name}/workflows
mkdir -p ~/.openclaw/skills/{skill-name}/references
```

## Step 5: Extract Workflows

For each identified workflow:

1. Create `workflows/{workflow-name}.md`
2. Add required_reading section (references it needs)
3. Add process section (steps from original skill)
4. Add success_criteria section

## Step 6: Extract References

For each identified reference topic:

1. Create `references/{reference-name}.md`
2. Move relevant content from original skill
3. Structure with semantic XML tags

## Step 7: Rewrite SKILL.md as Router

Replace SKILL.md with router structure:

```markdown
---
name: {skill-name}
description: {existing description}
---

<essential_principles>
[Extracted principles - inline, cannot be skipped]
</essential_principles>

<intake>
**Ask the user:**

What would you like to do?
1. [Workflow A option]
2. [Workflow B option]
...

**Wait for response before proceeding.**
</intake>

<routing>
| Response | Workflow |
|----------|----------|
| 1, "keywords" | `workflows/workflow-a.md` |
| 2, "keywords" | `workflows/workflow-b.md` |
</routing>

<reference_index>
[List all references by category]
</reference_index>

<workflows_index>
| Workflow | Purpose |
|----------|---------|
| workflow-a.md | [What it does] |
| workflow-b.md | [What it does] |
</workflows_index>
```

## Step 8: Verify Nothing Was Lost

Compare original skill content against new structure:
- [ ] All principles preserved (now inline)
- [ ] All procedures preserved (now in workflows)
- [ ] All knowledge preserved (now in references)
- [ ] No orphaned content

## Step 9: Test

Invoke the upgraded skill:
- Does intake question appear?
- Does each routing option work?
- Do workflows load correct references?
- Does behavior match original skill?

Report any issues.
</process>

<success_criteria>
Upgrade is complete when:
- [ ] workflows/ directory created with workflow files
- [ ] references/ directory created (if needed)
- [ ] SKILL.md rewritten as router
- [ ] Essential principles inline in SKILL.md
- [ ] All original content preserved
- [ ] Intake question routes correctly
- [ ] Tested and working
</success_criteria>
