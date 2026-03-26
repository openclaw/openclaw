# bodhi-push

Commit everything and push to GitHub in safe 1000-commit batches (handles the 2 GB GitHub push limit).

## Usage

```bash
chmod +x /home/bodhi/openbodhi/skills/bodhi-push/push.sh
/home/bodhi/openbodhi/skills/bodhi-push/push.sh "your commit message" [remote] [branch]
```

Defaults: remote=`origin`, branch=`main`.

## What it does

1. `git add -A` + `git commit -m "<message>"`
2. Checks remote reachability (SSH key / HTTPS token required).
3. Pushes in 1000-commit batches to stay under GitHub's 2 GB limit.
4. Final push for any remaining commits.

## Prerequisites

SSH key added to GitHub **or** HTTPS credential helper configured:

```bash
git remote set-url origin git@github.com:Qenjin/OpenBodhi.git
# or
git config --global credential.helper store  # then supply PAT once
```
