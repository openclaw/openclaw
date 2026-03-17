---
name: skill-finder
description: >
  Use when the user asks to find, search, or discover a skill that is not already
  installed. Does not handle updating or publishing skills — use the clawhub skill
  for those.
homepage: https://clawhub.com
metadata:
  openclaw:
    emoji: "🔍"
    requires:
      bins:
        - clawhub
        - curl
        - python3
        - git
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
- For updating or publishing skills — use the `clawhub` skill instead

---

## Step 1 — Search ClawHub (official registry)

Always start here. ClawHub is the official OpenClaw skill registry.

```bash
clawhub search "postgres"
clawhub search "linear"
clawhub search "jira"
clawhub search "docker"
clawhub search "gmail"
```

Output includes: skill name, description, version, author.

---

## Step 2 — Search GitHub for community skills

If ClawHub has no results, fall back to GitHub.

Note: set `GITHUB_TOKEN` in your environment for reliable results.
Unauthenticated requests are capped at 60/hour per IP and will silently
return empty results on 403 errors.

```bash
GITHUB_AUTH=""
if [ -n "$GITHUB_TOKEN" ]; then
  GITHUB_AUTH="-H Authorization:Bearer $GITHUB_TOKEN"
fi

# Search for openclaw skill repos
curl -s $GITHUB_AUTH \
  "https://api.github.com/search/repositories?q=openclaw+skill+KEYWORD&sort=stars&per_page=5" \
  | python3 -c "import sys,json; data=json.load(sys.stdin); print(data.get('message','')) if data.get('message') else [print(r['full_name'],'|',r.get('description',''),'|',r['html_url']) for r in data.get('items',[])]"

# Search for SKILL.md files matching a topic
curl -s $GITHUB_AUTH \
  "https://api.github.com/search/code?q=openclaw+KEYWORD+filename:SKILL.md&per_page=5" \
  | python3 -c "import sys,json; data=json.load(sys.stdin); print(data.get('message','')) if data.get('message') else [print(i['repository']['full_name'],'|',i['path'],'|',i['html_url']) for i in data.get('items',[])]"
```

Replace `KEYWORD` with the tool or topic the user asked about.

---

## Step 3 — Install from ClawHub

Once you find a skill on ClawHub:

```bash
clawhub install SKILL-NAME
clawhub install SKILL-NAME --version 1.2.3
clawhub list
```

---

## Step 4 — Install from GitHub (community)

If a skill is on GitHub but not on ClawHub:

```bash
REPO="owner/repo"
SKILL_PATH="skills/skill-name"
DEST="$(pwd)/skills/skill-name"

git clone --depth=1 --filter=blob:none --sparse \
  "https://github.com/$REPO.git" /tmp/skill-clone
cd /tmp/skill-clone
git sparse-checkout set "$SKILL_PATH"
cp -r "$SKILL_PATH" "$DEST"
cd /
rm -rf /tmp/skill-clone
echo "Installed to $DEST"
```

---

## Full Discovery Workflow

```bash
# 1. Search ClawHub first
clawhub search "KEYWORD"

# 2. If found on ClawHub, install directly
clawhub install SKILL-NAME

# 3. If NOT on ClawHub, search GitHub
GITHUB_AUTH=""
if [ -n "$GITHUB_TOKEN" ]; then
  GITHUB_AUTH="-H Authorization:Bearer $GITHUB_TOKEN"
fi
curl -s $GITHUB_AUTH \
  "https://api.github.com/search/repositories?q=openclaw+skill+KEYWORD&per_page=5" \
  | python3 -c "import sys,json; [print(r['full_name'],'|',r.get('description','')) for r in json.load(sys.stdin).get('items',[])]"

# 4. If found on GitHub, use the Step 4 clone flow above
```

---

## Suggest Creating a New Skill

If nothing exists anywhere, tell the user:

> "I couldn't find a skill for [X] on ClawHub or GitHub. I can write one for you —
> it's just a SKILL.md file with usage docs. Want me to create it?"

---

## Notes

- ClawHub registry: https://clawhub.com
- Default install dir: `./skills/` inside your OpenClaw workspace
- Override install dir: `--workdir /path` or `CLAWHUB_WORKDIR` env var
- Custom registry: `--registry https://my-registry.com` or `CLAWHUB_REGISTRY`
- Set `GITHUB_TOKEN` env var for reliable GitHub API search (avoids 60 req/hour rate limit)
- After installing a skill, OpenClaw picks it up automatically — no restart needed