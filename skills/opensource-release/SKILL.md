---
name: opensource-release
description: "Convert a private repository to public open-source. Use when making a repo public, sanitizing personal info from code/docs/git history, or preparing a project for open-source release. Triggers on 'open source', 'make public', 'public release', 'sanitize repo', '오픈소스 공개', '레포 공개'. NOT for: existing public repo maintenance, license-only changes, or general git operations."
---

# Open Source Release

Safely convert a private repo to public by sanitizing personal data and cleaning history.

## Workflow

1. **Scan** — find hardcoded paths, usernames, API keys, secrets in code + docs
2. **Fix** — replace with env vars / placeholders; ensure `.gitignore` covers caches
3. **History** — choose strategy: clean push (orphan branch) or BFG/filter-repo
4. **Publish** — `gh repo edit --visibility public`
5. **Verify** — final scan, check remote URL has no token

## Pre-flight Checklist

- [ ] Source code: no absolute paths, usernames, API keys, tokens
- [ ] Docs: no personal paths (use `$VAULT_PATH`, `~/vault`, etc.)
- [ ] `.gitignore`: covers `.env`, `__pycache__/`, `node_modules/`, binary caches
- [ ] Git remote URL: no embedded tokens
- [ ] Commit author config: no private email/phone

## History Strategy Decision

| Condition                           | Strategy                           |
| ----------------------------------- | ---------------------------------- |
| < 50 commits, cache only in history | Clean push (orphan branch)         |
| Large history with sensitive data   | BFG Repo Cleaner / git filter-repo |
| History is fine, just old paths     | Leave as-is                        |

## Quick Commands

```powershell
# Scan for sensitive strings
Get-ChildItem -Recurse -Include "*.py","*.ps1","*.js","*.ts","*.md" |
  Select-String -Pattern "C:\\Users|/home/" -SimpleMatch |
  Where-Object { $_.Path -notmatch "__pycache__|node_modules|\.git" }

# Clean push (orphan branch)
git checkout --orphan clean-main
git add -A
git commit -m "feat: initial public release"
git branch -M main
git push origin main --force

# Make public
gh repo edit {owner}/{repo} --visibility public --accept-visibility-change-consequences
```

## References

- `references/sanitization-guide.md` — detailed scan commands, fix patterns, verification steps
- `references/gotchas.md` — common pitfalls (tokens in URLs, binary caches, encoding)
