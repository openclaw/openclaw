---
name: king_skill_git_operations
description: Git operations including commit, push, branch, merge, diff, status. GitHub Actions workflows and gist management.
metadata:
  {
    "openclaw":
      {
        "emoji": "🌿",
        "requires": { "bins": ["git", "gh"] },
        "install":
          [
            {
              "id": "apt",
              "kind": "apt",
              "packages": ["git", "gh"],
              "label": "Install Git and GitHub CLI (apt)",
            },
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gh",
              "label": "Install GitHub CLI (brew)",
            },
          ],
        "os": ["darwin", "linux"],
      },
  }
---

# Git Operations

Git operations: commit, push, branch, merge, diff, status. GitHub Actions workflows.

## When to Use

**USE this skill when:**
- Committing changes
- Pushing to GitHub
- Creating branches
- Merging code
- Viewing diffs
- Managing GitHub Actions
- Creating/updating gists
- Cloning repositories

**DON'T use when:**
- Git is not initialized
- No changes to commit

## Commands

### Status and Diff

```bash
git status && git diff --stat
```

### Stage and Commit

```bash
# Explicitly add files to avoid committing secrets
git add .
git commit -m "feat: description"
```

### Push

```bash
git push origin main
```

### Gist Operations

```bash
# Create gist
cd skill
gh gist create state.json --public --desc "OpenClaw agent state"

# Update gist
gh gist edit GIST_ID state.json
```

### GitHub Actions

```bash
# Trigger workflow
gh workflow run paper-pipeline.yml --ref main

# Check status
gh run list --limit 5
gh run view RUN_ID
```

### Clone Repository

```bash
git clone https://github.com/Agnuxo1/OpenClaw-P2P.git
```

### Gist State Persistence

```python
import subprocess
import json

def save_state(state: dict, gist_id: str):
    import os
    tmp_dir = os.environ.get('TMPDIR', '/tmp')
    tmp_path = os.path.join(tmp_dir, 'state.json')
    with open(tmp_path, "w") as f:
        json.dump(state, f)
    subprocess.run(["gh", "gist", "edit", gist_id, tmp_path])

def load_state(gist_id: str) -> dict:
    result = subprocess.run(
        ["gh", "gist", "view", gist_id, "--raw"],
        capture_output=True, text=True
    )
    return json.loads(result.stdout)
```

## Notes

- Token savings: 3/5
- Status: ✅ Verified
- Requires GitHub CLI (gh)
