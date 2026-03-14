# Pre-Commit Hook for Secret Scanning

Prevent secrets from being committed to your repository using TruffleHog.

## Installation

### 1. Install TruffleHog

```bash
# macOS
brew install trufflehog

# Linux (verified binary — check https://github.com/trufflesecurity/trufflehog/releases for latest checksum)
curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh \
  -o /tmp/install-trufflehog.sh
# Verify the script before running (recommended):
# sha256sum /tmp/install-trufflehog.sh
bash /tmp/install-trufflehog.sh -b /usr/local/bin

# Or via Go (reproducible build)
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

# List staged files (added, copied, modified, renamed)
# -z uses NUL delimiters to handle filenames with spaces or newlines safely.
# ACMR includes Renames — without R, renamed files that gained new secrets
# would be silently skipped and the commit would pass.
STAGED_FILES=$(git diff --cached --name-only -z --diff-filter=ACMR)

if [ -z "$STAGED_FILES" ]; then
  echo "[pre-commit] ✅ No staged files to scan."
  exit 0
fi

# Use a distinct variable name (not TMPDIR — that is a reserved OS variable)
TH_TMPDIR=$(mktemp -d)
trap 'rm -rf "$TH_TMPDIR"' EXIT

# Extract staged versions of each file into the temp directory.
# read -d '' consumes NUL-delimited output from git diff -z, so filenames
# with spaces, tabs, or newlines are handled correctly.
while IFS= read -r -d '' file; do
  mkdir -p "$TH_TMPDIR/$(dirname "$file")"
  git show ":$file" > "$TH_TMPDIR/$file" 2>/dev/null || true
done <<< "$STAGED_FILES"

# Scan staged content — output is shown so users can see what triggered the block.
# NOTE: --only-verified is intentionally omitted. With that flag, TruffleHog
# silently skips secrets it cannot verify via outbound API (SSH keys, DB passwords,
# internal tokens). Omitting it reports all detected secrets so nothing slips through.
if ! trufflehog filesystem "$TH_TMPDIR" --fail; then
  echo ""
  echo "🚨 SECRETS DETECTED in staged files! Commit blocked."
  echo "Remove the secrets shown above before committing."
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

1. Lists all staged files (`git diff --cached --name-only -z --diff-filter=ACMR`) — NUL-delimited to handle special characters in filenames; includes renamed files (`R`) so secrets in renames are not missed
2. Extracts staged file content (`git show :filename`) into a temp directory
3. Runs TruffleHog `filesystem` scan on the staged snapshot — without `--only-verified` so SSH keys, database passwords, and internal tokens are not silently skipped
4. Prints findings so you can identify and remove the secret
5. Blocks the commit if any secrets are found
6. Temp directory is cleaned up automatically

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
- [TruffleHog Releases & Checksums](https://github.com/trufflesecurity/trufflehog/releases)
- [Catena-X TRG 8.03 - Secret Scanning](https://eclipse-tractusx.github.io/docs/release/trg-8/trg-8-03)
