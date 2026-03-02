# ClawHub Pre-Publish Checklist

Run this checklist against every skill before publishing or updating on ClawHub.

## Language Check

- [ ] `description:` in YAML frontmatter is **fully in English**
- [ ] SKILL.md body has **no Korean text**
- [ ] All `references/*.md` files are in English
- [ ] Table headers, section titles, and inline comments are in English

**How to detect Korean:**

```powershell
# Scan for non-ASCII characters (Korean, encoded garbage, etc.)
$text = Get-Content "C:\MAIBOT\skills\<skill-name>\SKILL.md" -Encoding UTF8 -Raw
if ($text -match '[가-힣ㄱ-ㅎㅏ-ㅣ]') { Write-Host "Korean found" } else { Write-Host "Clean" }
```

## Personal Info Check

- [ ] No absolute personal paths: `C:\Users\jini9`, `/home/jini9`, `JINI_SYNC`
- [ ] No internal hostnames or IP addresses
- [ ] No API keys, tokens, or passwords (even as examples)
- [ ] No personal email addresses
- [ ] No project-specific account names that aren't already public

**Replacement patterns:**
| Personal value | Generic placeholder |
|----------------|---------------------|
| `C:\Users\jini9\...` | `$env:USERPROFILE\...` or `~\...` |
| `JINI_SYNC` | `YOUR_VAULT_NAME` |
| `jini9` (as username) | `your-username` |
| `jini92.lee@gmail.com` | `your@email.com` |
| `C:\TEST\MAIBEAUTY` | `$PROJECT_ROOT` |

## Content Quality Check

- [ ] `description:` clearly states **what** the skill does AND **when** to trigger it
- [ ] Trigger keywords listed in description (both English and localized if relevant)
- [ ] At least one code example or command
- [ ] Common failure patterns documented if applicable
- [ ] No references to internal tools or systems that external users won't have

## Structure Check

- [ ] SKILL.md under ~500 lines (split to `references/` if longer)
- [ ] No README.md, CHANGELOG.md, or other auxiliary files
- [ ] `references/` files linked from SKILL.md with context on when to read them
- [ ] No symlinks in skill folder (ClawHub packaging rejects symlinks)

## Slug Selection

- [ ] Slug is lowercase + hyphens only
- [ ] Test for conflicts: attempt publish and check for "Only the owner can publish updates" error
- [ ] If conflict: append `-mai` suffix
- [ ] Slug does NOT contain personal info

## Post-Publish Verification

- [ ] `clawhub whoami` still returns authenticated user
- [ ] Skill appears at `https://clawhub.ai/u/jini92`
- [ ] Display name and description look correct on the page
- [ ] `memory/marketplace-strategy.md` updated with new row
- [ ] Obsidian `_DASHBOARD.md` updated with Done entry
