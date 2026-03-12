# Skill Design Patterns

## Progressive Disclosure Patterns

### Pattern 1: High-level guide with references

```markdown
# PDF Processing

## Quick start

Extract text with pdfplumber: [code example]

## Advanced features

- **Form filling**: See [FORMS.md](FORMS.md) for complete guide
- **API reference**: See [REFERENCE.md](REFERENCE.md) for all methods
```

Codex loads reference files only when needed.

### Pattern 2: Domain-specific organization

For skills with multiple domains, organize by domain to avoid loading irrelevant context:

```
bigquery-skill/
├── SKILL.md (overview + navigation)
└── references/
    ├── finance.md
    ├── sales.md
    └── product.md
```

Similarly for multi-framework skills:

```
cloud-deploy/
├── SKILL.md (workflow + provider selection)
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
```

### Pattern 3: Conditional details

```markdown
# DOCX Processing

## Creating documents

Use docx-js for new documents. See [DOCX-JS.md](DOCX-JS.md).

## Editing documents

For simple edits, modify the XML directly.
**For tracked changes**: See [REDLINING.md](REDLINING.md)
```

## Degrees of Freedom

| Level  | Format                   | When to use                                  |
| ------ | ------------------------ | -------------------------------------------- |
| High   | Text-based instructions  | Multiple approaches valid, context-dependent |
| Medium | Pseudocode w/ parameters | Preferred pattern exists, some variation OK  |
| Low    | Specific scripts         | Fragile operations, consistency critical     |

## Reference File Guidelines

- Keep references one level deep from SKILL.md
- For files >100 lines, include table of contents at top
- Avoid duplication between SKILL.md and references
- For large files (>10k words), include grep patterns in SKILL.md
- Info lives in SKILL.md OR references, not both

## Frontmatter Description Best Practices

The description is the **primary trigger mechanism**. Include:

- What the skill does
- Specific triggers/contexts for when to use it
- "NOT for" exclusions

Example:

```yaml
description: "Comprehensive document creation, editing, and analysis with
support for tracked changes, comments, formatting preservation, and text
extraction. Use when working with .docx files for: (1) Creating new documents,
(2) Modifying content, (3) Working with tracked changes. NOT for: plain text
or markdown files."
```

## Skill Naming Conventions

- Lowercase letters, digits, hyphens only
- Under 64 characters
- Prefer short, verb-led phrases
- Namespace by tool when helpful (e.g., `gh-address-comments`)
- Folder name = skill name

## What NOT to Include

- README.md, CHANGELOG.md, INSTALLATION_GUIDE.md
- Setup/testing procedures
- User-facing documentation
- Auxiliary context about creation process
