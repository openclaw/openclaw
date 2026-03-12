# Sanitization Guide — Detailed Steps

## Step 1: Code Scan

```powershell
# Find hardcoded paths and usernames
Get-ChildItem -Recurse -Include "*.py","*.ps1","*.js","*.ts" |
  Select-String -Pattern "C:\\Users|/home/|your-username" -SimpleMatch |
  Where-Object { $_.Path -notmatch "__pycache__|node_modules|\.git" }
```

Fix: replace with environment variables (`os.environ.get` / `process.env`) and add a `.env.example`.

## Step 2: Docs Scan

```powershell
Get-ChildItem -Recurse -Include "*.md","*.txt","*.yaml","*.yml" |
  Select-String -Pattern "C:\\Users|/home/|your-username" -SimpleMatch |
  Where-Object { $_.Path -notmatch "node_modules|\.git" }
```

Replace personal paths with generic placeholders (`$VAULT_PATH`, `~/vault`, etc.).

## Step 3: Git History Analysis

```powershell
git log --all -p | Select-String -Pattern "SENSITIVE_TERM" | Select-Object -First 50
git log --all --diff-filter=A -- "cache/*"
```

Choose a strategy:

- **< 50 commits + cache only in history** → Option B (clean push)
- **Large history with sensitive data** → Option A (BFG Repo Cleaner / git filter-repo)
- **History is fine, just old paths** → Option C (leave as-is)

## Step 4: Clean Push (Option B)

```powershell
git checkout --orphan clean-main
git add -A
git commit -m "feat: initial public release"
git remote set-url origin https://github.com/{owner}/{repo}.git  # verify no token in URL!
git branch -M main
git push origin main --force
git push origin --delete {old-branch}
```

## Step 5: Make Public

```powershell
gh repo edit {owner}/{repo} --visibility public --accept-visibility-change-consequences --description "Short description"
```

## Step 6: Verify

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

## Step 7: Post-Release Housekeeping (Optional)

- Add issue tracking to HEARTBEAT.md
- Update memory/{project}.md with release notes
