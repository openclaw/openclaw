# Bitwarden CLI get-started (summary)

- Works on macOS, Windows, and Linux.
  - macOS/Linux shells: bash, zsh, sh, fish.
  - Windows shell: PowerShell.
- Requires a Bitwarden account (free or paid).
- Install the CLI per the official doc for your OS.
- Login methods:
  - `bw login` - interactive login (email + master password)
  - `bw login --apikey` - non-interactive (client_id + client_secret)
  - `bw login --sso` - SSO login
- After login, export the session key: `export BW_SESSION="$(bw unlock --raw)"`
- For scripting, use `bw unlock --raw` to get a session token without interactive prompts.
- If multiple accounts: use `bw login <email>` to pick one.
- Session timeout: by default 30 minutes. Use `--timeout` or `BW_SESSION_TIMEOUT` to adjust.
