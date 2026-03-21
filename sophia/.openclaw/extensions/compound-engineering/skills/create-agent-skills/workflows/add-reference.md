# Workflow: Add a Reference to Existing Skill

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

Present numbered list, ask: "Which skill needs a new reference?"

## Step 2: Analyze Current Structure

```bash
cat ~/.openclaw/skills/{skill-name}/SKILL.md
ls ~/.openclaw/skills/{skill-name}/references/ 2>/dev/null
```

Determine:
- **Has references/ folder?** → Good, can add directly
- **Simple skill?** → May need to create references/ first
- **What references exist?** → Understand the knowledge landscape

Report current references to user.

## Step 3: Gather Reference Requirements

Ask:
- What knowledge should this reference contain?
- Which workflows will use it?
- Is this reusable across workflows or specific to one?

**If specific to one workflow** → Consider putting it inline in that workflow instead.

## Step 4: Create the Reference File

Create `references/{reference-name}.md`:

Use semantic XML tags to structure the content:
```xml
<overview>
Brief description of what this reference covers
</overview>

<patterns>
## Common Patterns
[Reusable patterns, examples, code snippets]
</patterns>

<guidelines>
## Guidelines
[Best practices, rules, constraints]
</guidelines>

<examples>
## Examples
[Concrete examples with explanation]
</examples>
```

## Step 5: Update SKILL.md

Add the new reference to `<reference_index>`:
```markdown
**Category:** existing.md, new-reference.md
```

## Step 6: Update Workflows That Need It

For each workflow that should use this reference:

1. Read the workflow file
2. Add to its `<required_reading>` section
3. Verify the workflow still makes sense with this addition

## Step 7: Verify

- [ ] Reference file exists and is well-structured
- [ ] Reference is in SKILL.md reference_index
- [ ] Relevant workflows have it in required_reading
- [ ] No broken references
</process>

<success_criteria>
Reference addition is complete when:
- [ ] Reference file created with useful content
- [ ] Added to reference_index in SKILL.md
- [ ] Relevant workflows updated to read it
- [ ] Content is reusable (not workflow-specific)
</success_criteria>
