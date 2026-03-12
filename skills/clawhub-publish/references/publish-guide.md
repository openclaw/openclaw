# ClawHub Publish Guide — Detailed Procedures

## Language & Sanitization Fix

If Korean or personal info found in SKILL.md:

1. Rewrite SKILL.md fully in English
2. Replace personal paths with generic placeholders:
   - `C:\Users\jini9\...` → `$env:USERPROFILE\...` or `~/...`
   - `JINI_SYNC` → `YOUR_VAULT_NAME`
   - `jini92` → `your-username`
3. Move any `references/*.md` content to English as well
4. Write with UTF-8: `[System.IO.File]::WriteAllText($path, $content, [System.Text.Encoding]::UTF8)`

## Version Determination

| Scenario                    | Version bump    |
| --------------------------- | --------------- |
| First publish               | `1.0.0`         |
| Content fix / translation   | `1.1.0` (minor) |
| New section / major rewrite | `2.0.0` (major) |
| Typo / small fix            | `1.0.1` (patch) |

## Batch Publish

To publish multiple skills at once, run the workflow for each in sequence.
Check `checklist.md` for the full quality bar before each.

## Korean Detection Script

```powershell
$text = Get-Content "C:\MAIBOT\skills\<skill-name>\SKILL.md" -Encoding UTF8 -Raw
if ($text -match '[가-힣ㄱ-ㅎㅏ-ㅣ]') { Write-Host "Korean found" } else { Write-Host "Clean" }
```

## Post-Publish Records

After successful publish, update:

- `C:\MAIBOT\memory\marketplace-strategy.md` — add row to ClawHub table
- Obsidian `_DASHBOARD.md` — add to Current Sprint as Done
