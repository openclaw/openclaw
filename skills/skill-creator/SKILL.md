---
name: skill-creator
description: Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, update or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.
---

# Skill Creator

This skill provides guidance for creating effective skills and iteratively improving them.

At a high level, the process of creating a skill goes like this:

- Decide what you want the skill to do and roughly how it should do it
- Write a draft of the skill
- Create a few test prompts to verify the skill works
- Evaluate the results both qualitatively and quantitatively
- Rewrite the skill based on evaluation feedback
- Repeat until satisfied
- Optimize the description for triggering accuracy

Your job is to figure out where the user is in this process and help them progress through these stages.

---

## About Skills

Skills are modular, self-contained packages that extend the agent's capabilities by providing specialized knowledge, workflows, and tools. Think of them as "onboarding guides" for specific domains or tasks — they transform a general-purpose agent into a specialized one equipped with procedural knowledge.

### What Skills Provide

1. Specialized workflows — Multi-step procedures for specific domains
2. Tool integrations — Instructions for working with specific file formats or APIs
3. Domain expertise — Company-specific knowledge, schemas, business logic
4. Bundled resources — Scripts, references, and assets for complex and repetitive tasks

## Core Principles

### Concise is Key

The context window is a public good. Skills share it with everything else: system prompt, conversation history, other skills' metadata, and the actual user request.

**Default assumption: the agent is already very smart.** Only add context it doesn't already have. Challenge each piece: "Does this justify its token cost?"

Prefer concise examples over verbose explanations.

### Set Appropriate Degrees of Freedom

- **High freedom (text instructions)**: Use when multiple approaches are valid or decisions depend on context.
- **Medium freedom (pseudocode/scripts with parameters)**: Use when a preferred pattern exists but some variation is acceptable.
- **Low freedom (specific scripts, few parameters)**: Use when operations are fragile and consistency is critical.

### Security: Principle of Lack of Surprise

Skills must not contain malware, exploit code, or any content that could compromise system security. A skill's contents should not surprise the user in their intent if described. Don't create misleading skills or skills designed to facilitate unauthorized access, data exfiltration, or other malicious activities.

### Anatomy of a Skill

Every skill consists of a required SKILL.md file and optional bundled resources:

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/          - Executable code (Python/Bash/etc.)
    ├── references/       - Documentation loaded into context as needed
    └── assets/           - Files used in output (templates, icons, fonts, etc.)
```

#### SKILL.md

- **Frontmatter** (YAML): Contains `name` and `description` fields. The description is the primary triggering mechanism — be clear and comprehensive about what the skill does and when it should be used. All "when to use" info goes here, not in the body.
- **Body** (Markdown): Instructions loaded only after the skill triggers.

#### Progressive Disclosure

Skills use a three-level loading system:
1. **Metadata** (name + description) — Always in context (~100 words)
2. **SKILL.md body** — When skill triggers (<500 lines ideal)
3. **Bundled resources** — As needed (unlimited; scripts can execute without loading)

When approaching the 500-line limit, split content into reference files and link to them clearly from SKILL.md.

#### Scripts (`scripts/`)

For tasks requiring deterministic reliability or repeated code. Test all added scripts by actually running them.

#### References (`references/`)

Documentation for the agent to reference while working. Keep SKILL.md lean; move detailed schemas, API docs, and domain knowledge here. For files >100 lines, include a table of contents.

#### Assets (`assets/`)

Files not loaded into context but used in output: templates, images, boilerplate code, fonts.

#### What NOT to Include

Do not create extraneous documentation: README.md, INSTALLATION_GUIDE.md, CHANGELOG.md, etc. The skill should only contain what's needed for an AI agent to do the job.

---

## Skill Creation Process

### Skill Naming

- Use lowercase letters, digits, and hyphens only; normalize to hyphen-case (e.g., "Plan Mode" → `plan-mode`).
- Keep names under 64 characters.
- Prefer short, verb-led or noun-led phrases that describe the action or domain.
- Namespace by tool when it improves clarity (e.g., `gh-address-comments`).

### Step 1: Understand the Skill with Concrete Examples

Clearly understand how the skill will be used before designing it. Ask questions like:

- "What functionality should this skill support?"
- "Can you give examples of how this would be used?"
- "What would a user say that should trigger this skill?"

Avoid asking too many questions at once — start with the most important and follow up as needed.

### Step 2: Plan Reusable Skill Contents

Analyze each example to identify what scripts, references, and assets would help. For each example:

1. Consider how to execute it from scratch
2. Identify what would be useful if this workflow is repeated

Example: For a `pdf-editor` skill handling "Rotate this PDF" — a `scripts/rotate_pdf.py` should be bundled.  
Example: For a `big-query` skill — a `references/schema.md` documenting table schemas would save repeated re-discovery.

### Step 3: Initialize the Skill

When creating a new skill from scratch, run `init_skill.py`:

```bash
scripts/init_skill.py <skill-name> --path <output-directory> [--resources scripts,references,assets] [--examples]
```

Examples:
```bash
scripts/init_skill.py my-skill --path skills/public
scripts/init_skill.py my-skill --path skills/public --resources scripts,references
```

Skip this step only if the skill already exists and you're iterating.

### Step 4: Build Test Cases

Before or alongside writing the skill, create 2–3 realistic test prompts — the kind a real user would actually type. Share them with the user for confirmation before running.

Save test cases to `evals/evals.json`:

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "User's task prompt",
      "expected_output": "Description of expected result",
      "files": []
    }
  ]
}
```

See `references/schemas.md` for the full schema (including the `assertions` field).

### Step 5: Edit the Skill

When editing the skill, remember it's being written for another agent instance to use. Include information that would be beneficial and non-obvious.

#### Update SKILL.md

**Frontmatter:**
- `name`: The skill name (hyphen-case, ≤64 chars)
- `description`: What it does + when to use it. Include all trigger contexts here — the body is only loaded after triggering. Make descriptions a little "pushy" to prevent under-triggering.

Do not include any other fields in YAML frontmatter.

**Body:**
- Write in imperative/infinitive form.
- Explain *why* things matter — don't just write MUST/NEVER. Today's agents have good reasoning; give them context to go beyond rote instructions.
- Use theory of mind: make the skill general, not narrowly fitted to specific examples.
- Write a draft, then review with fresh eyes.

**Writing patterns:**

Defining output formats:
```markdown
## Report structure
Always use this exact template:
# [Title]
## Executive summary
## Key findings
## Recommendations
```

Examples pattern:
```markdown
## Commit message format
**Example:**
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication
```

#### Start with Reusable Contents

Implement scripts, references, and assets first — before polishing SKILL.md prose. Test scripts by running them. Delete placeholder files from `--examples` if unused.

### Step 6: Package the Skill

Once development is complete, package into a distributable `.skill` file:

```bash
scripts/package_skill.py <path/to/skill-folder>
```

The script validates first (frontmatter format, naming, description quality, file structure), then packages into a zip with a `.skill` extension. Symlinks are rejected.

If validation fails, fix the errors and rerun.

### Step 7: Iterate

After testing on real tasks:

1. Notice struggles or inefficiencies
2. Identify how SKILL.md or bundled resources should change
3. Implement changes and test again

---

## Description Optimization

The `description` field is the primary mechanism that determines whether the agent invokes a skill. After creating or significantly changing a skill, offer to optimize the description for better triggering accuracy.

The `scripts/eval_description.py` script runs an optimization loop that:
1. Takes eval queries (should-trigger and should-not-trigger)
2. Tests the current description against them
3. Proposes improvements using the results
4. Iterates up to a configurable number of times
5. Returns the best description (by held-out test score, to avoid overfitting)

To generate and review eval queries before running optimization:

1. Create 15–20 realistic queries — mix of should-trigger and should-not-trigger. The most valuable negatives are near-misses that share keywords but actually need something different.
2. Read the template from `assets/eval_review.html`, fill in the placeholders, and write to a temp HTML file for user review.
3. After the user signs off, save the eval set and run the optimization script.
4. Apply `best_description` from the output to SKILL.md frontmatter. Show before/after to the user.

### How skill triggering works

Skills appear in the agent's `available_skills` list with name + description. The agent decides whether to consult a skill based on that description. Simple one-step queries may not trigger a skill even with a matching description — complex, multi-step, or specialized queries reliably trigger skills when the description matches.

Eval queries should therefore be substantive enough that an agent would actually benefit from consulting the skill.

---

## Writing Style

Try to explain to the agent *why* things are important, rather than using heavy-handed musty MUSTs. If you find yourself writing ALWAYS or NEVER in all caps, that's a yellow flag — reframe and explain the reasoning instead. Use theory of mind and keep the skill general, not narrowly fitted to specific examples.

---

## Reference Files

The `agents/` directory contains instructions for specialized subagents:
- `agents/grader.md` — How to evaluate assertions against outputs
- `agents/comparator.md` — How to do blind A/B comparison between two outputs
- `agents/analyzer.md` — How to analyze why one version beat another

The `references/` directory has additional documentation:
- `references/schemas.md` — JSON structures for evals.json, grading.json, benchmark.json, etc.

The `assets/` directory contains:
- `assets/eval_review.html` — HTML template for reviewing description eval queries with the user
