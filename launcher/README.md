# OpenClaw Launcher

交互式启动菜单，作为现有 `openclaw` CLI 的薄包装器。

## 设计理念

本启动器**不重复**现有 OpenClaw 功能，而是委托给现有 CLI 命令：

| 启动器功能   | 委托给                                        |
| ------------ | --------------------------------------------- |
| 启动 TUI     | `openclaw tui`                                |
| 启动 WebUI   | `openclaw dashboard`                          |
| 更新         | `openclaw update`                             |
| Gateway 管理 | `openclaw gateway start/stop/restart/install` |

## 构建

```bash
pnpm launcher:build
```

编译产物位于 `launcher/target/release/openclaw-launcher`（或 `.exe`）。

## 使用

### 交互式菜单

```bash
./openclaw-launcher
```

### 命令行模式

```bash
./openclaw-launcher tui          # 启动 TUI
./openclaw-launcher webui        # 启动 WebUI（打开浏览器）
./openclaw-launcher update       # 检查并更新
./openclaw-launcher gateway      # Gateway 服务管理子菜单
./openclaw-launcher --help       # 显示帮助
```

所有其他参数透传给 `openclaw` CLI。

## 安全说明

- **不存储敏感信息**：token 由 `openclaw dashboard` 命令处理，启动器不持久化
- **不执行破坏性操作**：更新委托给 `openclaw update`，不直接执行 git/pnpm 命令
- **不替代现有服务管理**：Gateway 通过 `openclaw gateway install` 使用系统服务管理器（launchd/systemd/schtasks）

## 系统要求

- Rust 1.70+（编译时）
- Node.js 22.19+（运行时，由 openclaw CLI 要求）
- 已安装的 `openclaw` CLI（通过 `npm install -g openclaw@latest` 或项目内 `pnpm openclaw`）
