# 1Password CLI get-started (summary)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Works on macOS, Windows, and Linux.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - macOS/Linux shells: bash, zsh, sh, fish.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Windows shell: PowerShell.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires a 1Password subscription and the desktop app to use app integration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS requirement: Big Sur 11.0.0 or later.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Linux app integration requires PolKit + an auth agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install the CLI per the official doc for your OS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Enable desktop app integration in the 1Password app:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Open and unlock the app, then select your account/collection.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - macOS: Settings > Developer > Integrate with 1Password CLI (Touch ID optional).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Windows: turn on Windows Hello, then Settings > Developer > Integrate.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Linux: Settings > Security > Unlock using system authentication, then Settings > Developer > Integrate.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- After integration, run any command to sign in (example in docs: `op vault list`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If multiple accounts: use `op signin` to pick one, or `--account` / `OP_ACCOUNT`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For non-integration auth, use `op account add`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
