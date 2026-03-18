# Skill Creator — Design Guide

## Step 1: Understanding the Skill

Ask the user for concrete examples of usage. Key questions:
- "What functionality should this skill support?"
- "Can you give examples of how it would be used?"
- "What would a user say that should trigger this skill?"

Avoid asking too many at once. Start with the most important, follow up as needed.

Conclude when you have a clear sense of the functionality and trigger patterns.

## Step 2: Planning Reusable Contents

Analyze each concrete example by: (1) how you'd execute it from scratch, (2) what reusable assets would help repeated execution.

Examples:
- PDF rotation → same code written repeatedly → `scripts/rotate_pdf.py`
- Frontend webapp → same boilerplate each time → `assets/hello-world/` template
- BigQuery queries → rediscovering table schemas → `references/schema.md`

Output: a list of scripts, references, and assets to build.

## Step 3: Initialize

```bash
scripts/init_skill.py <skill-name> --path <output-directory> [--resources scripts,references,assets] [--examples]
```

Examples:
```bash
scripts/init_skill.py my-skill --path skills/public
scripts/init_skill.py my-skill --path skills/public --resources scripts,references
```

The script creates the skill directory, generates SKILL.md template, optionally creates resource dirs and example files. Delete/replace placeholder example files after init.

## Step 4: Edit the Skill

You're writing for another agent instance. Include what's non-obvious. Procedural knowledge, domain specifics, reusable assets.

### References for Patterns

- `references/workflows.md` — multi-step processes and conditional logic
- `references/output-patterns.md` — specific output formats and quality standards

### Implementation Order

1. Build `scripts/`, `references/`, `assets/` files first
2. Test scripts by running them (test a representative sample for large batches)
3. Write SKILL.md last — reference the files you've built

### Frontmatter Writing Guidelines

**description field** — this is the trigger:
- Include: what it does, when to use, specific trigger phrases, NOT for exclusions
- Example (docx skill): "Comprehensive document creation, editing, and analysis with support for tracked changes, comments, formatting preservation, and text extraction. Use when working with .docx files for: (1) Creating new documents, (2) Modifying content, (3) Tracked changes, (4) Adding comments"

**Body writing**: Use imperative/infinitive form. Reference bundled files explicitly.

### Progressive Disclosure Patterns

**Pattern 1: High-level guide with references**
```markdown
## Advanced features
- **Form filling**: See `references/forms.md` for complete guide
- **API reference**: See `references/api.md` for all methods
```

**Pattern 2: Domain-specific organization**
```
bigquery-skill/
├── SKILL.md (overview + which file to read for which domain)
└── references/
    ├── finance.md   (revenue, billing metrics)
    ├── sales.md     (opportunities, pipeline)
    └── product.md   (API usage, features)
```
When user asks about sales → Codex reads only sales.md.

**Pattern 3: Framework variants**
```
cloud-deploy/
├── SKILL.md (workflow + provider selection guide)
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
```

**Pattern 4: Conditional details**
```markdown
For simple edits, modify the XML directly.
**For tracked changes**: See `references/redlining.md`
**For OOXML details**: See `references/ooxml.md`
```

### Structure Guidelines

- Keep SKILL.md body under 500 lines — split into references when approaching this
- All reference files link directly from SKILL.md (no nesting)
- Large reference files (>100 lines): include table of contents at top
- Information lives in SKILL.md OR references — not both
- Keep only essential procedural instructions in SKILL.md; detailed patterns/schemas → references

## Step 5: Package

```bash
scripts/package_skill.py <path/to/skill-folder>
# Optional output dir:
scripts/package_skill.py <path/to/skill-folder> ./dist
```

The script:
1. **Validates**: YAML frontmatter, naming conventions, description quality, file organization
2. **Packages**: creates `<skill-name>.skill` zip file for distribution

If validation fails, fix errors and re-run. Security: symlinks are rejected.

## Step 6: Iterate

After real usage:
1. Notice struggles or inefficiencies
2. Update SKILL.md or bundled resources
3. Re-package and test

## What NOT to Include

- README.md, INSTALLATION_GUIDE.md, CHANGELOG.md, QUICK_REFERENCE.md
- Setup/testing documentation
- User-facing docs
- Any auxiliary context about how the skill was created

The skill should only contain what an AI agent needs to do the job.
