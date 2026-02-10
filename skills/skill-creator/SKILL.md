---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: skill-creator（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Create or update AgentSkills. Use when designing, structuring, or packaging skills with scripts, references, and assets.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Skill Creator（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This skill provides guidance for creating effective skills.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## About Skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Skills are modular, self-contained packages that extend Codex's capabilities by providing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
specialized knowledge, workflows, and tools. Think of them as "onboarding guides" for specific（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
domains or tasks—they transform Codex from a general-purpose agent into a specialized agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
equipped with procedural knowledge that no model can fully possess.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What Skills Provide（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Specialized workflows - Multi-step procedures for specific domains（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Tool integrations - Instructions for working with specific file formats or APIs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Domain expertise - Company-specific knowledge, schemas, business logic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Bundled resources - Scripts, references, and assets for complex and repetitive tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Core Principles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Concise is Key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The context window is a public good. Skills share the context window with everything else Codex needs: system prompt, conversation history, other Skills' metadata, and the actual user request.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Default assumption: Codex is already very smart.** Only add context Codex doesn't already have. Challenge each piece of information: "Does Codex really need this explanation?" and "Does this paragraph justify its token cost?"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Prefer concise examples over verbose explanations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Set Appropriate Degrees of Freedom（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Match the level of specificity to the task's fragility and variability:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**High freedom (text-based instructions)**: Use when multiple approaches are valid, decisions depend on context, or heuristics guide the approach.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Medium freedom (pseudocode or scripts with parameters)**: Use when a preferred pattern exists, some variation is acceptable, or configuration affects behavior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Low freedom (specific scripts, few parameters)**: Use when operations are fragile and error-prone, consistency is critical, or a specific sequence must be followed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Think of Codex as exploring a path: a narrow bridge with cliffs needs specific guardrails (low freedom), while an open field allows many routes (high freedom).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Anatomy of a Skill（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Every skill consists of a required SKILL.md file and optional bundled resources:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
skill-name/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── SKILL.md (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   ├── YAML frontmatter metadata (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   │   ├── name: (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   │   └── description: (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   └── Markdown instructions (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── Bundled Resources (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ├── scripts/          - Executable code (Python/Bash/etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ├── references/       - Documentation intended to be loaded into context as needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    └── assets/           - Files used in output (templates, icons, fonts, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### SKILL.md (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Every SKILL.md consists of:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Frontmatter** (YAML): Contains `name` and `description` fields. These are the only fields that Codex reads to determine when the skill gets used, thus it is very important to be clear and comprehensive in describing what the skill is, and when it should be used.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Body** (Markdown): Instructions and guidance for using the skill. Only loaded AFTER the skill triggers (if at all).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Bundled Resources (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
##### Scripts (`scripts/`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Executable code (Python/Bash/etc.) for tasks that require deterministic reliability or are repeatedly rewritten.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **When to include**: When the same code is being rewritten repeatedly or deterministic reliability is needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Example**: `scripts/rotate_pdf.py` for PDF rotation tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Benefits**: Token efficient, deterministic, may be executed without loading into context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Note**: Scripts may still need to be read by Codex for patching or environment-specific adjustments（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
##### References (`references/`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Documentation and reference material intended to be loaded as needed into context to inform Codex's process and thinking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **When to include**: For documentation that Codex should reference while working（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Examples**: `references/finance.md` for financial schemas, `references/mnda.md` for company NDA template, `references/policies.md` for company policies, `references/api_docs.md` for API specifications（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Use cases**: Database schemas, API documentation, domain knowledge, company policies, detailed workflow guides（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Benefits**: Keeps SKILL.md lean, loaded only when Codex determines it's needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Best practice**: If files are large (>10k words), include grep search patterns in SKILL.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Avoid duplication**: Information should live in either SKILL.md or references files, not both. Prefer references files for detailed information unless it's truly core to the skill—this keeps SKILL.md lean while making information discoverable without hogging the context window. Keep only essential procedural instructions and workflow guidance in SKILL.md; move detailed reference material, schemas, and examples to references files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
##### Assets (`assets/`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Files not intended to be loaded into context, but rather used within the output Codex produces.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **When to include**: When the skill needs files that will be used in the final output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Examples**: `assets/logo.png` for brand assets, `assets/slides.pptx` for PowerPoint templates, `assets/frontend-template/` for HTML/React boilerplate, `assets/font.ttf` for typography（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Use cases**: Templates, images, icons, boilerplate code, fonts, sample documents that get copied or modified（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Benefits**: Separates output resources from documentation, enables Codex to use files without loading them into context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### What to Not Include in a Skill（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
A skill should only contain essential files that directly support its functionality. Do NOT create extraneous documentation or auxiliary files, including:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- README.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- INSTALLATION_GUIDE.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- QUICK_REFERENCE.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CHANGELOG.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- etc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The skill should only contain the information needed for an AI agent to do the job at hand. It should not contain auxiliary context about the process that went into creating it, setup and testing procedures, user-facing documentation, etc. Creating additional documentation files just adds clutter and confusion.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Progressive Disclosure Design Principle（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Skills use a three-level loading system to manage context efficiently:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Metadata (name + description)** - Always in context (~100 words)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **SKILL.md body** - When skill triggers (<5k words)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Bundled resources** - As needed by Codex (Unlimited because scripts can be executed without reading into context window)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Progressive Disclosure Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Keep SKILL.md body to the essentials and under 500 lines to minimize context bloat. Split content into separate files when approaching this limit. When splitting out content into other files, it is very important to reference them from SKILL.md and describe clearly when to read them, to ensure the reader of the skill knows they exist and when to use them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Key principle:** When a skill supports multiple variations, frameworks, or options, keep only the core workflow and selection guidance in SKILL.md. Move variant-specific details (patterns, examples, configuration) into separate reference files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Pattern 1: High-level guide with references**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# PDF Processing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Extract text with pdfplumber:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[code example]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Advanced features（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Form filling**: See [FORMS.md](FORMS.md) for complete guide（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **API reference**: See [REFERENCE.md](REFERENCE.md) for all methods（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Examples**: See [EXAMPLES.md](EXAMPLES.md) for common patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Codex loads FORMS.md, REFERENCE.md, or EXAMPLES.md only when needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Pattern 2: Domain-specific organization**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For Skills with multiple domains, organize content by domain to avoid loading irrelevant context:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bigquery-skill/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── SKILL.md (overview and navigation)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── reference/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ├── finance.md (revenue, billing metrics)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ├── sales.md (opportunities, pipeline)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ├── product.md (API usage, features)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    └── marketing.md (campaigns, attribution)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a user asks about sales metrics, Codex only reads sales.md.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Similarly, for skills supporting multiple frameworks or variants, organize by variant:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cloud-deploy/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── SKILL.md (workflow + provider selection)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── references/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ├── aws.md (AWS deployment patterns)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ├── gcp.md (GCP deployment patterns)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    └── azure.md (Azure deployment patterns)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the user chooses AWS, Codex only reads aws.md.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Pattern 3: Conditional details**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Show basic content, link to advanced content:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# DOCX Processing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Creating documents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use docx-js for new documents. See [DOCX-JS.md](DOCX-JS.md).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Editing documents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For simple edits, modify the XML directly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**For tracked changes**: See [REDLINING.md](REDLINING.md)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**For OOXML details**: See [OOXML.md](OOXML.md)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Codex reads REDLINING.md or OOXML.md only when the user needs those features.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Important guidelines:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Avoid deeply nested references** - Keep references one level deep from SKILL.md. All reference files should link directly from SKILL.md.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Structure longer reference files** - For files longer than 100 lines, include a table of contents at the top so Codex can see the full scope when previewing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Skill Creation Process（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Skill creation involves these steps:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Understand the skill with concrete examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Plan reusable skill contents (scripts, references, assets)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Initialize the skill (run init_skill.py)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Edit the skill (implement resources and write SKILL.md)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Package the skill (run package_skill.py)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Iterate based on real usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Follow these steps in order, skipping only if there is a clear reason why they are not applicable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Skill Naming（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use lowercase letters, digits, and hyphens only; normalize user-provided titles to hyphen-case (e.g., "Plan Mode" -> `plan-mode`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When generating names, generate a name under 64 characters (letters, digits, hyphens).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer short, verb-led phrases that describe the action.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Namespace by tool when it improves clarity or triggering (e.g., `gh-address-comments`, `linear-address-issue`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Name the skill folder exactly after the skill name.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Step 1: Understanding the Skill with Concrete Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Skip this step only when the skill's usage patterns are already clearly understood. It remains valuable even when working with an existing skill.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To create an effective skill, clearly understand concrete examples of how the skill will be used. This understanding can come from either direct user examples or generated examples that are validated with user feedback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For example, when building an image-editor skill, relevant questions include:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- "What functionality should the image-editor skill support? Editing, rotating, anything else?"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- "Can you give some examples of how this skill would be used?"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- "I can imagine users asking for things like 'Remove the red-eye from this image' or 'Rotate this image'. Are there other ways you imagine this skill being used?"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- "What would a user say that should trigger this skill?"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To avoid overwhelming users, avoid asking too many questions in a single message. Start with the most important questions and follow up as needed for better effectiveness.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Conclude this step when there is a clear sense of the functionality the skill should support.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Step 2: Planning the Reusable Skill Contents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To turn concrete examples into an effective skill, analyze each example by:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Considering how to execute on the example from scratch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Identifying what scripts, references, and assets would be helpful when executing these workflows repeatedly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example: When building a `pdf-editor` skill to handle queries like "Help me rotate this PDF," the analysis shows:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Rotating a PDF requires re-writing the same code each time（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. A `scripts/rotate_pdf.py` script would be helpful to store in the skill（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example: When designing a `frontend-webapp-builder` skill for queries like "Build me a todo app" or "Build me a dashboard to track my steps," the analysis shows:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Writing a frontend webapp requires the same boilerplate HTML/React each time（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. An `assets/hello-world/` template containing the boilerplate HTML/React project files would be helpful to store in the skill（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example: When building a `big-query` skill to handle queries like "How many users have logged in today?" the analysis shows:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Querying BigQuery requires re-discovering the table schemas and relationships each time（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. A `references/schema.md` file documenting the table schemas would be helpful to store in the skill（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To establish the skill's contents, analyze each concrete example to create a list of the reusable resources to include: scripts, references, and assets.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Step 3: Initializing the Skill（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
At this point, it is time to actually create the skill.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Skip this step only if the skill being developed already exists, and iteration or packaging is needed. In this case, continue to the next step.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When creating a new skill from scratch, always run the `init_skill.py` script. The script conveniently generates a new template skill directory that automatically includes everything a skill requires, making the skill creation process much more efficient and reliable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Usage:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/init_skill.py <skill-name> --path <output-directory> [--resources scripts,references,assets] [--examples]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/init_skill.py my-skill --path skills/public（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/init_skill.py my-skill --path skills/public --resources scripts,references（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/init_skill.py my-skill --path skills/public --resources scripts --examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The script:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Creates the skill directory at the specified path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Generates a SKILL.md template with proper frontmatter and TODO placeholders（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optionally creates resource directories based on `--resources`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optionally adds example files when `--examples` is set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After initialization, customize the SKILL.md and add resources as needed. If you used `--examples`, replace or delete placeholder files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Step 4: Edit the Skill（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When editing the (newly-generated or existing) skill, remember that the skill is being created for another instance of Codex to use. Include information that would be beneficial and non-obvious to Codex. Consider what procedural knowledge, domain-specific details, or reusable assets would help another Codex instance execute these tasks more effectively.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Learn Proven Design Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Consult these helpful guides based on your skill's needs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Multi-step processes**: See references/workflows.md for sequential workflows and conditional logic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Specific output formats or quality standards**: See references/output-patterns.md for template and example patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These files contain established best practices for effective skill design.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Start with Reusable Skill Contents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To begin implementation, start with the reusable resources identified above: `scripts/`, `references/`, and `assets/` files. Note that this step may require user input. For example, when implementing a `brand-guidelines` skill, the user may need to provide brand assets or templates to store in `assets/`, or documentation to store in `references/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Added scripts must be tested by actually running them to ensure there are no bugs and that the output matches what is expected. If there are many similar scripts, only a representative sample needs to be tested to ensure confidence that they all work while balancing time to completion.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you used `--examples`, delete any placeholder files that are not needed for the skill. Only create resource directories that are actually required.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Update SKILL.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Writing Guidelines:** Always use imperative/infinitive form.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
##### Frontmatter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Write the YAML frontmatter with `name` and `description`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `name`: The skill name（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `description`: This is the primary triggering mechanism for your skill, and helps Codex understand when to use the skill.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Include both what the Skill does and specific triggers/contexts for when to use it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Include all "when to use" information here - Not in the body. The body is only loaded after triggering, so "When to Use This Skill" sections in the body are not helpful to Codex.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Example description for a `docx` skill: "Comprehensive document creation, editing, and analysis with support for tracked changes, comments, formatting preservation, and text extraction. Use when Codex needs to work with professional documents (.docx files) for: (1) Creating new documents, (2) Modifying or editing content, (3) Working with tracked changes, (4) Adding comments, or any other document tasks"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Do not include any other fields in YAML frontmatter.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
##### Body（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Write instructions for using the skill and its bundled resources.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Step 5: Packaging a Skill（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Once development of the skill is complete, it must be packaged into a distributable .skill file that gets shared with the user. The packaging process automatically validates the skill first to ensure it meets all requirements:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/package_skill.py <path/to/skill-folder>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional output directory specification:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/package_skill.py <path/to/skill-folder> ./dist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The packaging script will:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Validate** the skill automatically, checking:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - YAML frontmatter format and required fields（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Skill naming conventions and directory structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Description completeness and quality（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - File organization and resource references（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Package** the skill if validation passes, creating a .skill file named after the skill (e.g., `my-skill.skill`) that includes all files and maintains the proper directory structure for distribution. The .skill file is a zip file with a .skill extension.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If validation fails, the script will report the errors and exit without creating a package. Fix any validation errors and run the packaging command again.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Step 6: Iterate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After testing the skill, users may request improvements. Often this happens right after using the skill, with fresh context of how the skill performed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Iteration workflow:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Use the skill on real tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Notice struggles or inefficiencies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Identify how SKILL.md or bundled resources should be updated（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Implement changes and test again（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
