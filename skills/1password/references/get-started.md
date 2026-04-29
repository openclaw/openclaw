# 1Password CLI get-started (summary)

- 适用于 macOS、Windows 和 Linux。
  - macOS/Linux shell：bash、zsh、sh、fish。
  - Windows shell：PowerShell。
- 需要 1Password 订阅，并且需要桌面应用才能使用应用集成。
- macOS 要求：Big Sur 11.0.0 或更高版本。
- Linux 应用集成需要 PolKit + 认证代理。
- 按照您的 OS 的官方文档安装 CLI。
- 在 1Password 应用中启用桌面应用集成：
  - 打开并解锁应用，然后选择您的账户/集合。
  - macOS：设置 > 开发者 > 与 1Password CLI 集成（Touch ID 可选）。
  - Windows：开启 Windows Hello，然后设置 > 开发者 > 集成。
  - Linux：设置 > 安全 > 使用系统认证解锁，然后设置 > 开发者 > 集成。
- 集成后，运行任何命令登录（例如：`op vault list`）。
- 如果有多个账户：使用 `op signin` 选择一个，或使用 `--account` / `OP_ACCOUNT`。
- 对于非集成认证，使用 `op account add`。
