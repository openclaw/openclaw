# 1Password CLI get-started (summary)

- Works on macOS, Windows, and Linux.
  - macOS/Linux shells: bash, zsh, sh, fish.
  - Windows shell: PowerShell.
- Requires a 1Password subscription and the desktop app to use app integration.
- macOS requirement: Big Sur 11.0.0 or later.
- Linux app integration requires PolKit + an auth agent.
- Install the CLI per the official doc for your OS.
- Enable desktop app integration in the 1Password app:
  - Open and unlock the app, then select your account/collection.
  - macOS: Settings > Developer > Integrate with 1Password CLI (Touch ID optional).
  - Windows: turn on Windows Hello, then Settings > Developer > Integrate.
  - Linux: Settings > Security > Unlock using system authentication, then Settings > Developer > Integrate.
- After integration, run any command to sign in (example in docs: `op vault list`).
- If multiple accounts: use `op signin` to pick one, or `--account` / `OP_ACCOUNT`.
- For non-integration auth, use `op account add`.
- Desktop app integration uses a per-user Unix domain socket the CLI must reach. Run `op` directly from the gateway's exec environment; wrapping in tmux can move the call into a different environment context where the socket is unreachable, producing `1Password CLI couldn't connect to the 1Password desktop app` errors.
  - macOS socket location: `~/Library/Group Containers/2BUA8C4S2C.com.1password/t/`
  - Service account auth (`OP_SERVICE_ACCOUNT_TOKEN`) does not use the desktop socket and works the same in or out of tmux.
