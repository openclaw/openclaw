---
name: skill-finder
description: Discover and install new OpenClaw skills by searching ClawHub and the web. Use when the user asks to find, search, or install a skill for a tool or task that is not already available.
homepage: https://clawhub.ai
metadata:
  openclaw:
    emoji: "🔍"
    requires:
      bins:
        - clawhub
        - curl
    install:
      - id: node
        kind: node
        package: clawhub
        bins:
          - clawhub
        label: "Install ClawHub CLI (npm)"
---

# skill-finder

Discover new OpenClaw skills from ClawHub and the web, then install them automatically.

## When to Use

Use this skill when the user asks something like:

- "Do you have a skill for X?"
- "Can you find a skill to help me with Y?"
- "Search for a Jira skill"
- "Install a skill for managing Linear issues"
- "What skills are available for databases?"

## When NOT to Use

- If a skill is already installed and working — use it directly
- For skills that don't exist anywhere — offer to create one instead

---

## Step 1 — Search ClawHub (official registry)

Always start here. ClawHub is the official OpenClaw skill registry.

```bash
# Search by keyword
clawhub search "postgres"
clawhub search "linear"
clawhub search "jira"
clawhub search "docker"
clawhub search "gmail"

# List all available skills
clawhub list
```

Output includes: skill name, description, version, author.

---

## Step 2 — Search the web for community skills

If ClawHub has no results, search GitHub and the web.

```bash
# Search GitHub for openclaw skills
curl -s "https://api.github.com/search/repositories?q=openclaw+skill+KEYWORD&sort=stars&per_page=5" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
for r in data.get('items', []):
    print(r['full_name'], '-', r['description'])
    print('  ', r['html_url'])
    print()
"

# Search GitHub for SKILL.md files matching a topic
curl -s "https://api.github.com/search/code?q=openclaw+KEYWORD+filename:SKILL.md&per_page=5" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data.get('items', []):
    print(item['repository']['full_name'])
    print('  File:', item['path'])
    print('  URL:', item['html_url'])
    print()
"
```

Replace `KEYWORD` with the tool or topic the user asked about.

---

## Step 3 — Install from ClawHub

Once you find a skill on ClawHub:

```bash
# Install latest version
clawhub install SKILL-NAME

# Install specific version
clawhub install SKILL-NAME --version 1.2.3

# Confirm it installed
clawhub list
```

---

## Step 4 — Install from GitHub (community)

If a skill is on GitHub but not on ClawHub:

```bash
# Clone just the skill folder
REPO="owner/repo"
SKILL_PATH="skills/skill-name"
DEST="./skills/skill-name"

git clone --depth=1 --filter=blob:none --sparse \
  "https://github.com/$REPO.git" /tmp/skill-clone
cd /tmp/skill-clone
git sparse-checkout set "$SKILL_PATH"
cp -r "$SKILL_PATH" "$DEST"
echo "Installed to $DEST"
```

---

## Step 5 — Update existing skills

```bash
# Update one skill
clawhub update SKILL-NAME

# Update all installed skills
clawhub update --all

# Force update even if hash matches
clawhub update --all --force
```

---

## Full Discovery Workflow

When the user asks for a skill you don't have:

```bash
# 1. Search ClawHub
clawhub search "KEYWORD"

# 2. If nothing found, search GitHub
curl -s "https://api.github.com/search/repositories?q=openclaw+skill+KEYWORD&per_page=5" \
  | python3 -c "import sys,json; [print(r['full_name'],'-',r.get('description','')) for r in json.load(sys.stdin).get('items',[])]"

# 3. Install the best match
clawhub install SKILL-NAME

# 4. Confirm and report back
clawhub list | grep SKILL-NAME
```

---

## Suggest Creating a New Skill

If nothing exists anywhere, tell the user:

> "I couldn't find a skill for [X] on ClawHub or GitHub. I can write one for you — it's just a `SKILL.md` file with usage docs. Want me to create it and publish it to ClawHub?"

To publish a new skill after creating it:

```bash
# Login first (one-time)
clawhub login

# Publish
clawhub publish ./skills/my-skill \
  --slug my-skill \
  --name "My Skill" \
  --version 1.0.0 \
  --changelog "Initial release"
```

---

## Notes

- ClawHub registry: https://clawhub.ai
- Default install dir: `./skills/` inside your OpenClaw workspace
- Override install dir: `--workdir /path` or `CLAWHUB_WORKDIR` env var
- Custom registry: `--registry https://my-registry.com` or `CLAWHUB_REGISTRY`
- After installing a skill, OpenClaw picks it up automatically — no restart needed
