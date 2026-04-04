# Commit Signing Guide

## Why Sign Commits?

Signed commits verify that code changes actually came from the claimed author, preventing impersonation attacks. This is especially important in an agentic CI/CD environment where bots and AI agents create commits.

## Setup (GPG)

### 1. Generate a GPG key
```bash
gpg --full-generate-key
# Choose RSA, 4096 bits, email matching your GitHub account
```

### 2. Get your key ID
```bash
gpg --list-secret-keys --keyid-format=long
# Copy the key ID after "sec rsa4096/"
```

### 3. Configure Git
```bash
git config --global user.signingkey YOUR_KEY_ID
git config --global commit.gpgsign true
```

### 4. Add to GitHub
```bash
gpg --armor --export YOUR_KEY_ID
# Copy output → GitHub Settings → SSH and GPG keys → New GPG key
```

## Agent Commits

Bot commits (shadow-healer, dependabot) use `GITHUB_TOKEN` which GitHub automatically verifies. These show as "Verified" without GPG setup.

## Verification

All commits on `main` should show the "Verified" badge on GitHub. Unsigned commits from unknown sources should be investigated.
