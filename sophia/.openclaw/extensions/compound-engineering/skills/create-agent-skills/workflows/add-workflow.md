# Workflow: Add a Workflow to Existing Skill

## Interaction Method

If `AskUserQuestion` is available, use it for all prompts below.

If not, present each question as a numbered list and wait for a reply before proceeding to the next step. Never skip or auto-configure.

<required_reading>
**Read these reference files NOW:**
1. references/recommended-structure.md
2. references/workflows-and-validation.md
</required_reading>

<process>
## Step 1: Select the Skill

**DO NOT use AskUserQuestion** - there may be many skills.

```bash
ls ~/.openclaw/skills/
```

Present numbered list, ask: "Which skill needs a new workflow?"

## Step 2: Analyze Current Structure

Read the skill:
```bash
cat ~/.openclaw/skills/{skill-name}/SKILL.md
ls ~/.openclaw/skills/{skill-name}/workflows/ 2>/dev/null
```

Determine:
- **Simple skill?** → May need to upgrade to router pattern first
- **Already has workflows/?** → Good, can add directly
- **What workflows exist?** → Avoid duplication

Report current structure to user.

## Step 3: Gather Workflow Requirements

Ask using AskUserQuestion or direct question:
- What should this workflow do?
- When would someone use it vs existing workflows?
- What references would it need?

## Step 4: Upgrade to Router Pattern (if needed)

**If skill is currently simple (no workflows/):**

Ask: "This skill needs to be upgraded to the router pattern first. Should I restructure it?"

If yes:
1. Create workflows/ directory
2. Move existing process content to workflows/main.md
3. Rewrite SKILL.md as router with intake + routing
4. Verify structure works before proceeding

## Step 5: Create the Workflow File

Create `workflows/{workflow-name}.md`:

```markdown
# Workflow: {Workflow Name}

<required_reading>
**Read these reference files NOW:**
1. references/{relevant-file}.md
</required_reading>

<process>
## Step 1: {First Step}
[What to do]

## Step 2: {Second Step}
[What to do]

## Step 3: {Third Step}
[What to do]
</process>

<success_criteria>
This workflow is complete when:
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3
</success_criteria>
```

## Step 6: Update SKILL.md

Add the new workflow to:

1. **Intake question** - Add new option
2. **Routing table** - Map option to workflow file
3. **Workflows index** - Add to the list

## Step 7: Create References (if needed)

If the workflow needs domain knowledge that doesn't exist:
1. Create `references/{reference-name}.md`
2. Add to reference_index in SKILL.md
3. Reference it in the workflow's required_reading

## Step 8: Test

Invoke the skill:
- Does the new option appear in intake?
- Does selecting it route to the correct workflow?
- Does the workflow load the right references?
- Does the workflow execute correctly?

Report results to user.
</process>

<success_criteria>
Workflow addition is complete when:
- [ ] Skill upgraded to router pattern (if needed)
- [ ] Workflow file created with required_reading, process, success_criteria
- [ ] SKILL.md intake updated with new option
- [ ] SKILL.md routing updated
- [ ] SKILL.md workflows_index updated
- [ ] Any needed references created
- [ ] Tested and working
</success_criteria>
