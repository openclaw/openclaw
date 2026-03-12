# Python Script for community-plugins.json

**⚠️ Never edit community-plugins.json with a text editor or shell commands.**
Unicode escapes (`\uXXXX`) will break, causing hundreds of lines of diff.

## Script: add_plugin.py

```python
import json

with open('community-plugins.json', 'r', encoding='utf-8') as f:
    plugins = json.load(f)

ids = [p['id'] for p in plugins]
if 'PLUGIN_ID' in ids:
    print('Already exists!')
else:
    plugins.append({
        "id": "PLUGIN_ID",
        "name": "Plugin Name",
        "author": "github-username",
        "description": "Same description as manifest.json",
        "repo": "owner/repo"
    })
    # ensure_ascii=True is REQUIRED — original uses \uXXXX escapes
    # newline='\n' is REQUIRED — original uses LF line endings
    with open('community-plugins.json', 'w', encoding='utf-8', newline='\n') as f:
        json.dump(plugins, f, indent=2, ensure_ascii=True)
        f.write('\n')
    print(f'Added! New count: {len(plugins)}')
```

## Post-Edit Verification (Required)

```powershell
# 1. JSON validity
python -c "import json; json.load(open('community-plugins.json','r',encoding='utf-8')); print('JSON valid')"

# 2. Diff should be minimal (~8 lines for one new entry)
git diff --stat
```
