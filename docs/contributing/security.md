# Security & Configuration

## Credentials
- Web provider: `~/.dna/credentials/`
- Rerun `dna login` if logged out

## Sessions
- Pi sessions: `~/.dna/sessions/` (base directory not configurable)

## Environment
- Variables: see `~/.profile`

## Sensitive Data
Never commit or publish:
- Real phone numbers
- Videos
- Live configuration values

Use obviously fake placeholders in docs, tests, examples.

## Release Signing
- Notary keys managed outside repo
- Follow internal release docs
- Required env vars:
  - `APP_STORE_CONNECT_ISSUER_ID`
  - `APP_STORE_CONNECT_KEY_ID`
  - `APP_STORE_CONNECT_API_KEY_P8`

## NPM Publish (1Password)

Use the 1password skill; all `op` commands in fresh tmux session.

```bash
# Sign in (app unlocked + integration on)
eval "$(op signin --account my.1password.com)"

# Get OTP
op read 'op://Private/Npmjs/one-time password?attribute=otp'

# Publish
npm publish --access public --otp="<otp>"

# Verify (without npmrc side effects)
npm view <pkg> version --userconfig "$(mktemp)"

# Kill tmux session after
```

## Troubleshooting
- Rebrand/migration issues or legacy config warnings: run `dna doctor`
- See `docs/gateway/doctor.md`
