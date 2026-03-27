---
name: eng-reviewer
description: >
  Review code changes for correctness, security, performance, and style using
  Gemini Flash. Accepts a repo path and commit hash. Produces a structured JSON
  verdict (pass/fail) with per-file issue annotations.
user-invocable: true
requires-env: [GEMINI_API_KEY]
requires-bins: [git, python3]
---

## When to Invoke

- After every eng-codex implementation phase
- On request from eng agent or user: "review the last commit in owner/repo"

## Inputs

| Argument        | Description                               |
| --------------- | ----------------------------------------- |
| `repo_path`     | Absolute path to the git repo or worktree |
| `commit_or_ref` | Commit hash, branch name, or `HEAD`       |
| `task_id`       | Used to name the output file              |

## Output

Writes structured JSON to `.eng/reviews/{task_id}.json`:

```json
{
  "verdict": "pass",
  "issues": [
    {
      "file": "src/api.py",
      "line": 42,
      "severity": "critical|major|minor",
      "description": "SQL query not parameterized",
      "suggestion": "Use parameterized queries via cursor.execute(sql, params)"
    }
  ],
  "summary": "One critical SQL injection risk found."
}
```

`verdict = "fail"` only when critical or major issues are present. Minor issues alone = pass.

Exit code: 0 = pass, 1 = fail.

## Running the Skill

```bash
python3 /app/skills/eng-reviewer/review.py \
  /tmp/worktrees/abc123 \
  HEAD \
  abc123
```
