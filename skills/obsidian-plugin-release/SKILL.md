---
name: obsidian-plugin-release
description: "Submit Obsidian community plugins to the official marketplace via obsidian-releases PR. End-to-end process from repo validation to PR merge. Battle-tested from PR #10404 (9 failures) → PR #10406 (1-shot pass). Triggers: 'Obsidian 플러그인 배포', 'plugin release', 'obsidian-releases PR', 'community plugin submit', '옵시디언 플러그인 등록', 'submit plugin to Obsidian', 'marketplace 등록'. NOT for: plugin development/coding, Obsidian vault management, non-Obsidian marketplace deploys (use marketplace-deploy)."
---

# Obsidian Community Plugin Release

Submit plugins to the Obsidian Community Plugin Marketplace.

## Process (6 Steps)

### 1. Repo Structure Validation

Verify root-level files: `manifest.json`, `LICENSE` (OSI), `README.md`

- manifest.json: `id`, `name`, `version`, `minAppVersion`, `description`, `author`
- **description must NOT contain "Obsidian"** — use "for your vault" instead
- Run validation script: see `references/validation-script.md`

### 2. GitHub Release

```powershell
gh release create $version main.js manifest.json styles.css `
  --title $version --notes "Release $version" --repo owner/repo
```

- **No `v` prefix** — `0.1.0` not `v0.1.0`
- Attach individual files (not source zip)

### 3. Fork obsidian-releases + Edit JSON

- Fork `obsidianmd/obsidian-releases`, clone with `--depth 1`
- **Edit community-plugins.json with Python only** (preserves `\uXXXX` escapes)
- See `references/json-edit-script.md` for the Python script
- Verify: `git diff --stat` should show ~8 lines changed

### 4. Create PR (Template Required)

- Use exact PR template — bot parses the body
- See `references/pr-template.md` for full template
- Title: `Add plugin: Plugin Name`

### 5. Bot Validation

```powershell
gh pr view <PR#> -R obsidianmd/obsidian-releases --json comments --jq '.comments[-1].body'
```

- Pass → wait for review. Fail → fix, push, minimize re-validations

### 6. Review & Merge

- Obsidian team reviews (days to weeks)
- Respond to review comments promptly

## Common Pitfalls

See `references/common-pitfalls.md` for the full table from PR #10404 experience.

## References

- `references/validation-script.md` — PowerShell pre-flight checks
- `references/json-edit-script.md` — Python script for community-plugins.json
- `references/pr-template.md` — Official PR body template
- `references/common-pitfalls.md` — Lessons from PR #10404
- [Official docs](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
