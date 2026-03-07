# Pre-Commit Hook for Secret Scanning

Prevent secrets from being committed to your repository using TruffleHog.

## Installation

### 1. Install TruffleHog

```bash
# macOS
brew install trufflehog

# Linux (download binary)
curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh | sh -s -- -b /usr/local/bin

# Or via Go
go install github.com/trufflesecurity/trufflehog/v3@latest
```

### 2. Create Pre-Commit Hook

Create `.git/hooks/pre-commit` in your repository:

```bash
#!/usr/bin/env bash
# Pre-commit hook: Secret scanning with TruffleHog
# Scans staged files for verified secrets before each commit

set -euo pipefail

echo "[pre-commit] Scanning staged files for secrets..."

# Write staged content to a temp directory and scan it
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$STAGED_FILES" ]; then
  echo "[pre-commit] ✅ No staged files to scan."
  exit 0
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Extract staged versions of each file into tmpdir
while IFS= read -r file; do
  mkdir -p "$TMPDIR/$(dirname "$file")"
  git show ":$file" > "$TMPDIR/$file" 2>/dev/null || true
done <<< "$STAGED_FILES"

# Scan staged content with TruffleHog filesystem mode
if ! trufflehog filesystem "$TMPDIR" --only-verified --fail 2>/dev/null; then
  echo ""
  echo "🚨 SECRETS DETECTED in staged files! Commit blocked."
  echo "Remove secrets before committing."
  echo ""
  exit 1
fi

echo "[pre-commit] ✅ No secrets found."
exit 0
```

### 3. Make it Executable

```bash
chmod +x .git/hooks/pre-commit
```

## How It Works

1. Lists all staged files (`git diff --cached --name-only`)
2. Extracts staged file content (`git show :filename`) into a temp directory
3. Runs TruffleHog `filesystem` scan on the staged snapshot
4. Blocks the commit if verified secrets are found
5. Temp directory is cleaned up automatically

This approach correctly scans **staged (uncommitted) content** — not just git history.

## Bypassing (Emergency Only)

If you need to bypass the hook (not recommended):

```bash
git commit --no-verify -m "your message"
```

## Team Setup

To share the hook with your team, add it to your repo:

```bash
mkdir -p .githooks
cp .git/hooks/pre-commit .githooks/
git config core.hooksPath .githooks
```

Then commit `.githooks/pre-commit` to your repository.

## References

- [TruffleHog Documentation](https://trufflesecurity.com/trufflehog)
- [Catena-X TRG 8.03 - Secret Scanning](https://eclipse-tractusx.github.io/docs/release/trg-8/trg-8-03)
