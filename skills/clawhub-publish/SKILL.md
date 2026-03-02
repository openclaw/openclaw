---
name: clawhub-publish
description: Publish OpenClaw skills to ClawHub marketplace (clawhub.ai). Use when deploying a skill to ClawHub for the first time, updating an existing published skill, or when user says "스킬 배포", "ClawHub에 올려줘", "publish skill", "스킬 퍼블리시", "ClawHub publish". Handles language check (Korean → English), personal info sanitization, versioning, and clawhub CLI publish.
---

# ClawHub Publish

## Prerequisites

- clawhub CLI installed: `npm i -g clawhub`
- Logged in: `clawhub whoami` (if not: `clawhub login` via PTY + browser)
- Target skill folder exists under `C:\MAIBOT\skills\<skill-name>\`

## Workflow

### 1. Pre-publish Checklist

Run against each skill before publishing. See `references/checklist.md` for full criteria.

**Quick scan:**

```powershell
Get-Content "C:\MAIBOT\skills\<skill-name>\SKILL.md" -Encoding UTF8 | Select-Object -First 40
```

Must verify:

- [ ] `description:` field is in **English** (this is what ClawHub users see first)
- [ ] No Korean text in SKILL.md body
- [ ] No personal paths (`C:\Users\jini9`, `JINI_SYNC`, etc.)
- [ ] No internal account names or credentials
- [ ] Generic placeholders used where personal config appeared

### 2. Language & Sanitization Fix

If Korean or personal info is found:

1. Rewrite SKILL.md fully in English
2. Replace personal paths with generic placeholders (`$VAULT_PATH`, `~/vault`, `your-username`)
3. Move any `references/*.md` content to English as well
4. Write with UTF-8: `[System.IO.File]::WriteAllText($path, $content, [System.Text.Encoding]::UTF8)`

### 3. Determine Version

| Scenario                    | Version bump    |
| --------------------------- | --------------- |
| First publish               | `1.0.0`         |
| Content fix / translation   | `1.1.0` (minor) |
| New section / major rewrite | `2.0.0` (major) |
| Typo / small fix            | `1.0.1` (patch) |

### 4. Publish

```powershell
cd C:\MAIBOT
clawhub publish ./skills/<skill-name> `
  --slug <slug> `
  --name "<Display Name>" `
  --version <X.Y.Z> `
  --changelog "<one-line summary of changes>"
```

**Slug rules:**

- Lowercase, hyphens only
- Must be globally unique on ClawHub
- If slug taken: append `-mai` suffix (e.g., `obsidian-daily-mai`)

### 5. Verify

```powershell
clawhub whoami   # confirm still authenticated
# Then check: https://clawhub.ai/u/jini92
```

### 6. Update Records

After successful publish, update both:

- `C:\MAIBOT\memory\marketplace-strategy.md` — add row to ClawHub table
- Obsidian `_DASHBOARD.md` — add to Current Sprint as Done

## Batch Publish

To publish multiple skills at once, run steps 1–4 for each in sequence.
Check `references/checklist.md` for the full quality bar before each.

## Common Errors

| Error                                | Fix                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `Not logged in`                      | Run `clawhub login` in PTY mode; open browser URL when shown             |
| `Only the owner can publish updates` | Slug taken by another user; add `-mai` suffix                            |
| `Login session timeout (code 1)`     | Rerun `clawhub login` — PTY must stay alive until browser auth completes |
