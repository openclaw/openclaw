# Skills System

## Overview

DNA's skill system follows Anthropic's Agent Skill convention—each skill is a directory with a `SKILL.md` file containing YAML frontmatter and instructions.

## Skill Loading Precedence

1. `<workspace>/skills` — Per-agent workspace skills
2. `~/.dna/skills` — Shared skills across agents
3. Bundled skills — Shipped with DNA

## Installing Community Skills

```bash
npx clawdhub@latest install <skill-slug>
# or
dna skills install <skill-name>
```

## Notable Skills for Entrepreneurs

### E-Commerce & Business

| Skill | Description |
|-------|-------------|
| pinch-to-post | WordPress/WooCommerce product/inventory management |
| hubspot | CRM and marketing automation |
| shopify | Shopify store management |

### Productivity

| Skill | Description |
|-------|-------------|
| todoist | Task management |
| linear | Project management |
| notion | Workspace management |
| obsidian | Vault management |
| obsidian-daily | Daily notes |

### Communication

| Skill | Description |
|-------|-------------|
| slack | Team communication |
| discord | Community management |

### Deployment

| Skill | Description |
|-------|-------------|
| vercel | Vercel deployment automation |
| coolify | Self-hosted deployment |

## Creating Custom Skills

### Directory Structure

```
my-skill/
├── SKILL.md          # Required: metadata + instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
└── assets/           # Optional: templates, icons
```

### SKILL.md Structure

```yaml
---
name: my-ecommerce-skill
description: Manages inventory across stores
metadata:
  dna:
    emoji: "📦"
    requires:
      bins: ["shop-cli"]
---
# Instructions

When the user asks about inventory, use shop-cli to check stock levels...

## Available Commands

- `shop-cli inventory list` — List all products
- `shop-cli inventory update <sku> <qty>` — Update stock

## Examples

User: "How many blue shirts do we have?"
Action: Run `shop-cli inventory list --filter=blue-shirt`
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| name | Yes | Skill identifier |
| description | Yes | What the skill does and when to use it |
| metadata.dna.emoji | No | Display emoji |
| metadata.dna.requires.bins | No | Required binaries |

## Skill Development Best Practices

1. **Keep instructions concise** — Claude is already smart
2. **Include concrete examples** — Show expected inputs/outputs
3. **Specify triggers clearly** — What user messages activate the skill
4. **List dependencies** — Required tools, APIs, permissions

## Discovery Resources

- **ClawdHub registry:** https://clawdhub.com
- **Awesome list:** https://github.com/VoltAgent/awesome-moltbot-skills (565+ skills)
- **GitHub topic:** https://github.com/topics/dna-skill

## Testing Skills

Place skill in workspace and trigger with relevant message:

```bash
# Copy skill to workspace
cp -r my-skill ~/clawd/skills/

# Restart to pick up changes
dna daemon restart

# Test via chat
```
