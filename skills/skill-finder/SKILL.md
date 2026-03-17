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
        - jq
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

Run `clawhub search` with the keyword the user asked about:

    clawhub search "KEYWORD"

Output includes: skill name, description, version, author. If a match is found, go to Step 3.

---

## Step 2 — Search GitHub for community skills

If ClawHub has no results, search GitHub as a fallback.

Set `GITHUB_TOKEN` in your environment before running these commands.
Unauthenticated requests are capped at 60/hour per IP.

Search for skill repos:

    curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
      "https://api.github.com/search/repositories?q=openclaw+skill+KEYWORD&sort=stars&per_page=5" \
      | jq -r ".items[].full_name"

Search for SKILL.md files:

    curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
      "https://api.github.com/search/code?q=openclaw+KEYWORD+filename:SKILL.md&per_page=5" \
      | jq -r ".items[].html_url"

If results are found, use the owner/repo path in Step 4.

---

## Step 3 — Install from ClawHub

    clawhub install SKILL-NAME

Verify with `clawhub list`. The skill is available immediately — no restart needed.

---

## Step 4 — Install from GitHub (community)

If a skill is on GitHub but not on ClawHub, clone and copy it:

    REPO="owner/repo"
    SKILL_PATH="skills/skill-name"
    DEST="$(pwd)/skills/skill-name"
    git clone --depth=1 --filter=blob:none --sparse "https://github.com/$REPO.git" /tmp/skill-clone
    cd /tmp/skill-clone
    git sparse-checkout set "$SKILL_PATH"
    cp -r "$SKILL_PATH" "$DEST"
    cd /
    rm -rf /tmp/skill-clone

---

## Suggest Creating a New Skill

If nothing is found anywhere, tell the user:

    I could not find a skill for X on ClawHub or GitHub.
    I can write one for you — it is just a SKILL.md file with usage docs.
    Want me to create it?

---

## Notes

- ClawHub registry: https://clawhub.com
- Default install dir: ./skills/ inside your OpenClaw workspace
- Override with --workdir /path or CLAWHUB_WORKDIR env var
- Set GITHUB_TOKEN for reliable GitHub API search (avoids 60 req/hour rate limit)
- After installing, OpenClaw picks up the skill automatically — no restart needed