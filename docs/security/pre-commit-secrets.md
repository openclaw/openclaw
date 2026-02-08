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
# Blocks commits containing verified secrets

set -euo pipefail

echo "[pre-commit] Scanning for secrets..."

# Run TruffleHog on staged changes
if ! trufflehog git file://. --since-commit HEAD~1 --branch HEAD --only-verified --fail 2>/dev/null; then
  echo ""
  echo "🚨 SECRETS DETECTED! Commit blocked."
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

- Scans all staged files before each commit
- Only flags **verified** secrets (reduces false positives)
- Blocks the commit if secrets are found
- Allows commit if clean

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
