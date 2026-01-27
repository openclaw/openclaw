---
title: Contributing Skills
description: How to create, test, and publish Clawdbot skills
---

# Contributing Skills

This guide walks you through creating skills for Clawdbot, from your first `SKILL.md` to publishing on ClawdHub.

## What is a Skill?

A skill is a directory containing a `SKILL.md` file that teaches Clawdbot how to use a tool, service, or workflow. Skills are injected into the system prompt and guide the AI agent on how to accomplish specific tasks.

Skills follow the [AgentSkills](https://agentskills.io) specification with Clawdbot-specific extensions.

## Quick Start

Create your first skill in under 5 minutes:

```bash
# Create skill directory
mkdir -p ~/.clawdbot/skills/my-calculator

# Create SKILL.md
cat > ~/.clawdbot/skills/my-calculator/SKILL.md << 'EOF'
---
name: my-calculator
description: Perform calculations using bc (basic calculator)
metadata: {"clawdbot":{"requires":{"bins":["bc"]}}}
---

# Calculator

Use `bc` for arithmetic calculations.

## Examples

Simple math:
```bash
echo "2 + 2" | bc
```

With decimals (scale=2):
```bash
echo "scale=2; 10 / 3" | bc
```

## Notes
- Always use `echo "expression" | bc` pattern
- Set `scale=N` for decimal precision
EOF
```

Start a new Clawdbot session and the skill will be available.

## SKILL.md Format

### Required Fields

Every `SKILL.md` must have YAML frontmatter with at least:

```yaml
---
name: skill-name
description: One-line description of what this skill does
---
```

### Full Frontmatter Reference

```yaml
---
name: my-skill                    # Unique identifier (kebab-case)
description: Short description    # Shown in skill lists
homepage: https://example.com     # Link to tool/service docs
user-invocable: true              # Expose as /my-skill command (default: true)
disable-model-invocation: false   # Exclude from AI prompt (default: false)
command-dispatch: tool            # Optional: bypass AI, call tool directly
command-tool: exec                # Tool to invoke when command-dispatch is set
command-arg-mode: raw             # How to pass args (default: raw)
metadata: {"clawdbot":{...}}      # Clawdbot-specific configuration (see below)
---
```

### Metadata Object

The `metadata` field must be a **single-line JSON object** (parser limitation):

```yaml
metadata: {"clawdbot":{"emoji":"🔧","requires":{"bins":["jq"]},"primaryEnv":"MY_API_KEY"}}
```

#### Metadata Fields

| Field | Type | Description |
|-------|------|-------------|
| `emoji` | string | Display emoji for UI |
| `homepage` | string | URL for documentation link |
| `always` | boolean | Skip all gating, always load |
| `os` | string[] | Platform filter: `["darwin"]`, `["linux"]`, `["win32"]` |
| `requires.bins` | string[] | All binaries must exist on PATH |
| `requires.anyBins` | string[] | At least one binary must exist |
| `requires.env` | string[] | Environment variables (or config equivalents) |
| `requires.config` | string[] | Config paths that must be truthy |
| `primaryEnv` | string | Main env var for `skills.entries.<name>.apiKey` |
| `install` | object[] | Installation instructions for UI |
| `skillKey` | string | Override config key (default: skill name) |

### Gating Requirements

Skills are filtered at load time based on `metadata.clawdbot.requires`:

```yaml
# Require specific binaries
metadata: {"clawdbot":{"requires":{"bins":["gh","jq"]}}}

# Require at least one of these binaries
metadata: {"clawdbot":{"requires":{"anyBins":["vim","nvim"]}}}

# Require environment variable (or config equivalent)
metadata: {"clawdbot":{"requires":{"env":["GITHUB_TOKEN"]}}}

# Require config value to be set
metadata: {"clawdbot":{"requires":{"config":["browser.enabled"]}}}

# Platform-specific (macOS only)
metadata: {"clawdbot":{"os":["darwin"]}}

# Combine requirements
metadata: {"clawdbot":{"requires":{"bins":["uv"],"env":["GEMINI_API_KEY"]},"os":["darwin","linux"]}}
```

### Install Specs

Help users install dependencies via the macOS Skills UI:

```yaml
# Homebrew
metadata: {"clawdbot":{"install":[{"id":"brew","kind":"brew","formula":"gh","bins":["gh"],"label":"Install GitHub CLI (brew)"}]}}

# npm (global)
metadata: {"clawdbot":{"install":[{"id":"npm","kind":"node","package":"my-cli","bins":["my-cli"],"label":"Install my-cli (npm)"}]}}

# Go
metadata: {"clawdbot":{"install":[{"id":"go","kind":"go","package":"github.com/user/tool@latest","bins":["tool"],"label":"Install tool (go)"}]}}

# uv (Python)
metadata: {"clawdbot":{"install":[{"id":"uv","kind":"brew","formula":"uv","bins":["uv"],"label":"Install uv (brew)"}]}}

# Download (tarball/zip)
metadata: {"clawdbot":{"install":[{"id":"download","kind":"download","url":"https://example.com/tool.tar.gz","archive":"tar.gz","bins":["tool"],"label":"Download tool"}]}}

# Platform-specific
metadata: {"clawdbot":{"install":[{"id":"brew-mac","kind":"brew","formula":"tool","bins":["tool"],"os":["darwin"]},{"id":"apt-linux","kind":"download","url":"https://example.com/tool-linux","os":["linux"]}]}}
```

## Writing Good Instructions

The body of `SKILL.md` (after frontmatter) is injected into the system prompt. Write clear, actionable instructions.

### Do

- Use code blocks with specific commands
- Include common use cases and examples
- Document required environment variables
- Explain output formats the agent should expect
- Use `{baseDir}` to reference the skill directory

### Don't

- Write lengthy explanations (tokens cost money)
- Include installation instructions (use `install` metadata)
- Duplicate information already in tool --help
- Add promotional content

### Example Structure

```markdown
# Tool Name

Brief description of what this tool does.

## Commands

Primary command:
```bash
tool command --flag "argument"
```

With options:
```bash
tool command --verbose --output json
```

## Environment

- `TOOL_API_KEY`: Required API key
- `TOOL_REGION`: Optional region (default: us-east-1)

## Notes
- Important behavior to know
- Common gotchas
```

### Using {baseDir}

Reference files within your skill directory:

```markdown
Run the bundled script:
```bash
uv run {baseDir}/scripts/generate.py --prompt "hello"
```
```

Clawdbot replaces `{baseDir}` with the actual skill path at runtime.

## Supporting Files

Skills can include additional files:

```
my-skill/
├── SKILL.md           # Required
├── scripts/           # Helper scripts
│   └── generate.py
├── templates/         # Template files
│   └── config.yaml
└── examples/          # Example usage
    └── demo.sh
```

Reference these with `{baseDir}`:

```markdown
Use the template:
```bash
cp {baseDir}/templates/config.yaml ./my-config.yaml
```
```

## Testing Your Skill

### Local Testing

1. Create the skill in `~/.clawdbot/skills/` or `<workspace>/skills/`
2. Verify it loads: `clawdbot skills list`
3. Check gating: `clawdbot skills info <name>`
4. Start a session and test the skill

### Checking Eligibility

```bash
# List all skills with status
clawdbot skills list

# Detailed skill info
clawdbot skills info my-skill

# Check why a skill isn't loading
clawdbot doctor
```

### Token Impact

Skills add to your prompt token count. Estimate:

- Base overhead: ~50 tokens (when any skills load)
- Per skill: ~25 tokens + your instruction length

Keep instructions concise. Every character counts.

## Configuration

Users can configure your skill in `~/.clawdbot/clawdbot.json`:

```json5
{
  skills: {
    entries: {
      "my-skill": {
        enabled: true,
        apiKey: "sk-xxx",           // Maps to primaryEnv
        env: {
          MY_API_KEY: "sk-xxx",     // Additional env vars
          MY_REGION: "us-east-1"
        },
        config: {
          endpoint: "https://api.example.com"  // Custom config
        }
      }
    }
  }
}
```

Access custom config via environment or document the config path for users.

## Publishing to ClawdHub

### Prerequisites

1. Install the ClawdHub CLI: `npm i -g clawdhub`
2. Log in: `clawdhub login`

### First Publish

```bash
# Navigate to your skill
cd ~/.clawdbot/skills/my-skill

# Publish
clawdhub publish . \
  --slug my-skill \
  --name "My Skill" \
  --version 1.0.0 \
  --changelog "Initial release"
```

### Updating

```bash
# Bump version and publish
clawdhub publish . \
  --slug my-skill \
  --version 1.1.0 \
  --changelog "Added new feature"
```

### Sync Workflow

For managing multiple skills:

```bash
# Scan and publish all new/updated skills
clawdhub sync --all

# Preview what would be published
clawdhub sync --dry-run

# Specify version bump type
clawdhub sync --all --bump minor
```

### Versioning

ClawdHub uses semantic versioning:

- **Patch** (1.0.1): Bug fixes, documentation updates
- **Minor** (1.1.0): New features, backward compatible
- **Major** (2.0.0): Breaking changes to usage or requirements

## Best Practices

### Naming

- Use kebab-case: `my-skill-name`
- Be descriptive but concise
- Avoid generic names: prefer `github-pr-review` over `github`

### Dependencies

- Prefer tools available via Homebrew, npm, or Go
- Document all required binaries in `requires.bins`
- Provide install specs for the macOS UI
- Test on a clean system

### Security

- Never hardcode secrets in `SKILL.md`
- Use `requires.env` for API keys
- Document environment variables clearly
- Consider sandbox compatibility

### Documentation

- Write for the AI agent, not humans
- Use imperative commands: "Run...", "Use...", "Execute..."
- Include example output when helpful
- Keep instructions under 1KB when possible

## Example Skills

Browse the bundled skills for patterns:

| Skill | Description | Key Patterns |
|-------|-------------|--------------|
| [nano-banana-pro](https://github.com/clawdbot/clawdbot/tree/main/skills/nano-banana-pro) | Image generation | Python script, uv, API key |
| [github](https://github.com/clawdbot/clawdbot/tree/main/skills/github) | GitHub operations | gh CLI, OAuth |
| [peekaboo](https://github.com/clawdbot/clawdbot/tree/main/skills/peekaboo) | macOS screenshots | Platform-specific, node binary |
| [gemini](https://github.com/clawdbot/clawdbot/tree/main/skills/gemini) | Gemini CLI | Homebrew install |

## Troubleshooting

### Skill not loading

1. Check `clawdbot skills list` for status
2. Run `clawdbot doctor` for diagnostics
3. Verify binary requirements: `which <binary>`
4. Check env vars: `echo $MY_VAR`
5. Validate SKILL.md syntax (single-line metadata JSON)

### Gating issues

```bash
# Debug skill eligibility
clawdbot skills info my-skill --verbose
```

### Publish errors

- Ensure you're logged in: `clawdhub whoami`
- Check slug uniqueness on clawdhub.com
- Verify SKILL.md is valid YAML frontmatter

## Resources

- [Skills reference](/tools/skills) - Full configuration docs
- [ClawdHub guide](/tools/clawdhub) - Registry CLI reference
- [Sandboxing](/gateway/sandboxing) - Running skills in containers
- [Feature maturity](/reference/feature-maturity) - Skills system stability
- [clawdhub.com](https://clawdhub.com) - Browse existing skills
