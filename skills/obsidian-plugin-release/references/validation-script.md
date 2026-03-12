# Repo Validation Script

Run this before submitting to verify all requirements.

```powershell
$repoRoot = "C:\path\to\repo"

# 1. manifest.json exists at root + parse
$manifest = Get-Content "$repoRoot\manifest.json" -Raw | ConvertFrom-Json
Write-Host "✅ manifest.json parsed: id=$($manifest.id), version=$($manifest.version)"

# 2. description must not contain "Obsidian"
if ($manifest.description -match "Obsidian") {
  Write-Host "❌ description contains 'Obsidian' — remove it!"
} else {
  Write-Host "✅ description OK (no 'Obsidian')"
}

# 3. LICENSE exists
if (Test-Path "$repoRoot\LICENSE") { Write-Host "✅ LICENSE exists" }
else { Write-Host "❌ LICENSE missing!" }

# 4. README.md exists
if (Test-Path "$repoRoot\README.md") { Write-Host "✅ README.md exists" }
else { Write-Host "❌ README.md missing!" }
```

## manifest.json Required Fields

```json
{
  "id": "plugin-id",
  "name": "Plugin Name",
  "version": "X.Y.Z",
  "minAppVersion": "1.0.0",
  "description": "Description without the word Obsidian",
  "author": "github-username",
  "authorUrl": "https://github.com/username",
  "isDesktopOnly": false
}
```
