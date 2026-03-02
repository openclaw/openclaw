---
name: opensource-release
description: Convert a private repository to public open-source. Use when making a repo public, sanitizing personal info from code/docs/git history, or preparing a project for open-source release. Triggers on "open source", "make public", "public release", "sanitize repo".
---

# Open Source Release

Safely convert a private repo to public by sanitizing personal data and cleaning history.

## Pre-flight Checklist

1. **Scan source code** — search for:
   - Absolute paths: `C:\Users\`, home directory references
   - Usernames: OS-specific account names
   - Internal hostnames / port names
   - API keys / tokens: `.env`, hardcoded secrets
   - Email / phone numbers in commit author config

2. **Check cached artifacts** — ensure `.gitignore` covers:
   - Binary caches (`.pkl`, `.db`, `checksums.json`)
   - `__pycache__/`, `node_modules/`, `.env`, `*.egg-info/`
   - Project-specific cache directories

## Sanitization Steps

### Step 1: Code Scan

```powershell
# Find hardcoded paths and usernames
Get-ChildItem -Recurse -Include "*.py","*.ps1","*.js","*.ts" |
  Select-String -Pattern "C:\\Users|/home/|your-username" -SimpleMatch |
  Where-Object { $_.Path -notmatch "__pycache__|node_modules|\.git" }
```

Fix: replace with environment variables (`os.environ.get` / `process.env`) and add a `.env.example`.

### Step 2: Docs Scan

```powershell
Get-ChildItem -Recurse -Include "*.md","*.txt","*.yaml","*.yml" |
  Select-String -Pattern "C:\\Users|/home/|your-username" -SimpleMatch |
  Where-Object { $_.Path -notmatch "node_modules|\.git" }
```

Replace personal paths with generic placeholders (`$VAULT_PATH`, `~/vault`, etc.).

### Step 3: Git History Analysis

```powershell
git log --all -p | Select-String -Pattern "SENSITIVE_TERM" | Select-Object -First 50
git log --all --diff-filter=A -- "cache/*"
```

Choose a strategy:

- **< 50 commits + cache only in history** → Option B (clean push)
- **Large history with sensitive data** → Option A (BFG Repo Cleaner / git filter-repo)
- **History is fine, just old paths** → Option C (leave as-is)

### Step 4: Clean Push (Option B)

```powershell
git checkout --orphan clean-main
git add -A
git commit -m "feat: initial public release"
git remote set-url origin https://github.com/{owner}/{repo}.git  # verify no token in URL!
git branch -M main
git push origin main --force
git push origin --delete {old-branch}
```

### Step 5: Make Public

```powershell
gh repo edit {owner}/{repo} --visibility public --accept-visibility-change-consequences --description "Short description"
```

### Step 6: Verify

```powershell
# Final scan for sensitive strings
Get-ChildItem -Recurse -Include "*.py","*.md","*.yaml","*.js","*.ts" |
  Select-String -Pattern "SENSITIVE_TERM" -SimpleMatch |
  Where-Object { $_.Path -notmatch "__pycache__|node_modules|\.git" }

# Confirm remote URL has no token
git remote -v

# Confirm visibility
gh repo view {owner}/{repo} --json visibility
```

### Step 7: Post-Release Housekeeping (Optional)

- Add issue tracking to HEARTBEAT.md
- Update memory/{project}.md with release notes

## Gotchas

- **Never include tokens in git remote URLs** — always verify before push
- **Binary caches** not covered by `.gitignore` may already be in history — check carefully
- **Encoding issues on Windows** — use UTF-8 explicitly in PowerShell/Python
- Your GitHub username is already public — that is fine to leave as-is
- Never commit `.env` files — add to `.gitignore` if not already there
