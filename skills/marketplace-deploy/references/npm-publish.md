# npm Publish with 1Password OTP

## Setup

All `op` commands must run inside a fresh tmux session.

### 1Password Auth

```bash
eval "$(op signin --account my.1password.com)"
```

### Get OTP

```bash
op read 'op://Private/Npmjs/one-time password?attribute=otp'
```

### Get Password (for npm login)

```bash
op item get Npmjs --format=json | jq -r '.fields[] | select(.id=="password").value'
```

## Publish Flow

```bash
# 1. Start tmux session
tmux new -d -s release-$(date +%Y%m%d-%H%M%S)

# 2. Sign in to 1Password
eval "$(op signin --account my.1password.com)"

# 3. Get OTP
OTP=$(op read 'op://Private/Npmjs/one-time password?attribute=otp')

# 4. Publish
npm publish --access public --otp="$OTP"

# 5. Verify (without local npmrc side effects)
npm view <package-name> version --userconfig "$(mktemp)"

# 6. Kill tmux session
tmux kill-session -t release-*
```

## Scoped Packages

For `@scope/package` names, always use `--access public` unless private registry.

## Troubleshooting

- **403 Forbidden**: Check npm auth token, ensure logged in
- **OTP expired**: Re-fetch from 1Password (30s window)
- **Version conflict**: Bump version before retry
