# Skills Development Guide

Skills extend DNA's capabilities. This guide shows how to use, create, and share skills.

## What Are Skills?

Skills are markdown files that teach DNA how to do specific tasks. They contain:
- Instructions for the AI
- Reference documentation
- Scripts and commands
- Templates

## Using Built-in Skills

DNA comes with 60+ skills. They're automatically available — just ask:

```
"Check my GitHub notifications"        → github skill
"What's on my calendar?"               → gog skill
"What's the weather in Paris?"         → weather skill
"Create a new note about project X"    → apple-notes skill
```

### Listing Available Skills

```bash
ls skills/
```

Or ask DNA:
```
"What skills do you have?"
```

---

## Skill Structure

A skill is a folder with at least a `SKILL.md` file:

```
skills/
└── my-skill/
    ├── SKILL.md           # Required: Main instructions
    ├── references/        # Optional: Documentation
    │   └── api-docs.md
    ├── scripts/           # Optional: Helper scripts
    │   └── helper.sh
    └── templates/         # Optional: File templates
        └── template.md
```

### SKILL.md Format

```markdown
# My Skill

Brief description of what this skill does.

## When to Use

- Trigger phrase 1
- Trigger phrase 2

## Prerequisites

- Required tool or API
- Environment variables needed

## Commands

### Command 1
\`\`\`bash
my-command --flag
\`\`\`

### Command 2
Explanation of what it does.

## Examples

### Example: Do something
1. Step one
2. Step two
3. Result

## Troubleshooting

### Error: Something failed
Solution: How to fix it
```

---

## Creating a Custom Skill

### Step 1: Create the Folder

```bash
mkdir -p ~/dna-workspace/skills/my-skill
```

### Step 2: Write SKILL.md

```bash
cat > ~/dna-workspace/skills/my-skill/SKILL.md << 'EOF'
# My Custom Skill

This skill helps with [specific task].

## When to Use

Use this skill when:
- User asks about X
- User wants to do Y

## How to Use

1. First, do this
2. Then do that
3. Finally, check the result

## Commands

### Main Command
```bash
some-cli-tool --option value
```

## Examples

### Example: Basic Usage
User: "Help me with X"
Response: [What DNA should do]
EOF
```

### Step 3: Test It

Ask DNA:
```
"Use my-skill to help me with X"
```

---

## Skill Examples

### Simple Skill: Daily Standup

```markdown
# Daily Standup

Generate a daily standup report.

## When to Use

- "Generate my standup"
- "What did I do yesterday?"
- "Standup report"

## How to Generate

1. Check git commits from yesterday:
   \`\`\`bash
   git log --since="yesterday" --author="$(git config user.name)" --oneline
   \`\`\`

2. Check today's calendar events

3. Format as:
   - **Yesterday:** [commits and completed tasks]
   - **Today:** [calendar events and planned tasks]
   - **Blockers:** [any issues]
```

### Advanced Skill: API Integration

```markdown
# Weather Skill

Get weather forecasts.

## Prerequisites

No API key required (uses wttr.in).

## Commands

### Current Weather
\`\`\`bash
curl -s "wttr.in/${CITY}?format=3"
\`\`\`

### Detailed Forecast
\`\`\`bash
curl -s "wttr.in/${CITY}"
\`\`\`

## Examples

### Example: Check Weather
User: "What's the weather in Tokyo?"

1. Run: \`curl -s "wttr.in/Tokyo?format=3"\`
2. Parse response
3. Reply: "Tokyo: ☀️ +15°C"
```

---

## Adding References

For complex skills, add reference documentation:

```
skills/my-skill/
├── SKILL.md
└── references/
    ├── api-docs.md
    ├── examples.md
    └── troubleshooting.md
```

Reference in SKILL.md:
```markdown
## References

See [API Documentation](references/api-docs.md) for full API details.
```

---

## Adding Scripts

For skills that need helper scripts:

```
skills/my-skill/
├── SKILL.md
└── scripts/
    ├── setup.sh
    └── helper.py
```

Reference in SKILL.md:
```markdown
## Setup

Run the setup script:
\`\`\`bash
./skills/my-skill/scripts/setup.sh
\`\`\`
```

---

## Skill Best Practices

### 1. Be Specific About Triggers

❌ Bad:
```markdown
## When to Use
Use this skill for various tasks.
```

✅ Good:
```markdown
## When to Use
- User says "check my PRs"
- User asks about "GitHub pull requests"
- User wants to "review code"
```

### 2. Include Prerequisites

```markdown
## Prerequisites

- GitHub CLI (`gh`) installed: `brew install gh`
- Authenticated: `gh auth login`
```

### 3. Provide Examples

```markdown
## Examples

### Example: List Open PRs
User: "Show my open pull requests"

1. Run: `gh pr list --author @me`
2. Format results as a list
3. Reply with PR titles and links
```

### 4. Handle Errors

```markdown
## Troubleshooting

### Error: "gh: command not found"
Install GitHub CLI:
\`\`\`bash
brew install gh
\`\`\`

### Error: "not logged in"
Authenticate:
\`\`\`bash
gh auth login
\`\`\`
```

---

## Sharing Skills

### Export a Skill

```bash
cp -R ~/dna-workspace/skills/my-skill /path/to/share/
```

### Import a Skill

```bash
cp -R /path/to/my-skill ~/dna-workspace/skills/
```

### Contribute to DNA

1. Fork the DNA repository
2. Add skill to `skills/` folder
3. Submit pull request

---

## Built-in Skills Reference

| Skill | Description | Prerequisites |
|-------|-------------|---------------|
| `github` | GitHub CLI integration | `gh` CLI |
| `gog` | Google Workspace | OAuth setup |
| `weather` | Weather forecasts | None |
| `apple-notes` | macOS Notes | macOS |
| `apple-reminders` | macOS Reminders | macOS |
| `notion` | Notion API | API key |
| `slack` | Slack integration | Bot token |
| `coding-agent` | Run coding agents | Node.js |
| `dna-expert` | DNA self-help | None |

See individual skill folders for full documentation.
