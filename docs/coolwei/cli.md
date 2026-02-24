# src/cli 详解

## 概述

`src/cli/` 是 OpenClaw 的命令行界面（CLI）层，负责将用户在终端输入的命令解析、路由并执行。它是用户与 OpenClaw 系统交互的主要入口之一，基于 [Commander.js](https://github.com/tj/commander.js) 构建，采用懒加载注册和依赖注入模式。

## 启动流程

CLI 的入口是 `run-main.ts` 中的 `runCli()` 函数，执行流程如下：

1. 规范化 Windows 参数（`normalizeWindowsArgv`）
2. 加载 `.env` 环境变量
3. 规范化环境变量（`normalizeEnv`）
4. 确保 CLI 在 PATH 中可用（`ensureOpenClawCliOnPath`）
5. 检查运行时版本（Node 22+）
6. 尝试快速路由（`tryRouteCli`）— 对已知命令跳过完整的 Commander 解析
7. 启用控制台日志捕获
8. 构建 Commander 程序（`buildProgram`）
9. 注册全局错误处理器
10. 懒加载注册匹配的命令模块
11. 注册插件 CLI 命令
12. 解析并执行命令

## 核心架构

### 命令注册机制

CLI 采用两级懒加载注册，避免启动时加载所有命令模块：

**核心命令**（`program/command-registry.ts`）：

| 命令                             | 说明                              |
| -------------------------------- | --------------------------------- |
| `setup`                          | 初始化本地配置和 Agent 工作区     |
| `onboard`                        | 交互式引导向导                    |
| `configure`                      | 交互式凭证/频道/Gateway 配置      |
| `config`                         | 非交互式配置读写（get/set/unset） |
| `doctor`                         | 健康检查和快速修复                |
| `dashboard`                      | 打开 Control UI                   |
| `reset`                          | 重置本地配置/状态                 |
| `uninstall`                      | 卸载 Gateway 服务                 |
| `message`                        | 消息收发管理                      |
| `memory`                         | 记忆搜索和重建索引                |
| `agent` / `agents`               | 运行 Agent / 管理多 Agent         |
| `status` / `health` / `sessions` | 状态、健康、会话查看              |
| `browser`                        | 管理内置浏览器（Chrome/Chromium） |

**子 CLI 命令**（`program/register.subclis.ts`）：

| 命令         | 说明                             |
| ------------ | -------------------------------- |
| `gateway`    | 运行、查询 WebSocket Gateway     |
| `daemon`     | Gateway 服务管理（legacy 别名）  |
| `logs`       | 通过 RPC 查看 Gateway 日志       |
| `system`     | 系统事件、心跳、在线状态         |
| `models`     | 模型发现、扫描、配置             |
| `approvals`  | 执行审批管理                     |
| `nodes`      | 节点配对和命令管理               |
| `devices`    | 设备配对和 token 管理            |
| `node`       | 无头节点主机服务                 |
| `sandbox`    | 沙箱容器管理                     |
| `tui`        | 终端 UI                          |
| `cron`       | 定时任务管理                     |
| `dns`        | DNS 和广域发现                   |
| `docs`       | 搜索在线文档                     |
| `hooks`      | Agent 钩子管理                   |
| `webhooks`   | Webhook 集成                     |
| `qr`         | iOS 配对二维码生成               |
| `channels`   | 频道管理（Telegram、Discord 等） |
| `directory`  | 联系人和群组 ID 查询             |
| `security`   | 安全工具和配置审计               |
| `skills`     | 技能列表和检查                   |
| `update`     | 更新 OpenClaw                    |
| `plugins`    | 插件管理                         |
| `pairing`    | DM 配对审批                      |
| `completion` | Shell 自动补全脚本生成           |

懒加载机制：CLI 启动时只注册一个占位命令（placeholder），当用户实际调用该命令时才动态 `import()` 对应模块并重新解析参数。这大幅减少了启动时间。

### 快速路由（Route）

`route.ts` 实现了一个快速路径：对于已知的常用命令，跳过完整的 Commander 注册流程，直接路由到对应的处理函数。这进一步优化了 CLI 响应速度。

### 依赖注入（CliDeps）

`deps.ts` 定义了 `CliDeps` 类型和 `createDefaultDeps()` 工厂函数，封装了所有频道的消息发送函数：

```typescript
type CliDeps = {
  sendMessageWhatsApp: ...;
  sendMessageTelegram: ...;
  sendMessageDiscord: ...;
  sendMessageSlack: ...;
  sendMessageSignal: ...;
  sendMessageIMessage: ...;
};
```

每个发送函数都使用动态 `import()` 延迟加载，只在实际发送消息时才加载对应频道模块。这个 deps 对象贯穿整个 CLI 和 Gateway，也方便测试时 mock。

### Gateway RPC 通信

`gateway-rpc.ts` 提供了 CLI 与运行中的 Gateway 通信的桥梁：

- 通过 WebSocket 调用 Gateway 方法
- 支持 `--url`、`--token`、`--timeout` 等选项
- 自动显示进度指示器
- 大部分 CLI 命令（如 `status`、`channels`、`sessions`）底层都是通过 RPC 调用 Gateway

### Profile 支持

`profile.ts` 实现了多配置文件（profile）支持：

- `--profile <name>`：使用指定的配置 profile
- `--dev`：等同于 `--profile dev`，自动使用端口 19001
- 每个 profile 有独立的状态目录（`~/.openclaw-<profile>/`）和配置文件
- 允许在同一台机器上运行多个独立的 OpenClaw 实例

### 进度显示

`progress.ts` 是统一的 CLI 进度显示模块：

- 支持 OSC 进度条（终端原生进度条）
- 回退到 `@clack/prompts` spinner
- 支持行内进度、日志输出等多种模式
- 支持百分比和不确定进度
- 自动检测 TTY 环境

## 子目录结构

| 目录                         | 说明                                                      |
| ---------------------------- | --------------------------------------------------------- |
| `program/`                   | Commander 程序构建、命令注册、帮助格式化、预处理钩子      |
| `gateway-cli/`               | `openclaw gateway` 子命令（run、dev、discover、call）     |
| `daemon-cli/`                | Gateway 服务生命周期管理（install、start、stop、status）  |
| `cron-cli/`                  | Cron 定时任务子命令（add、edit、list）                    |
| `nodes-cli/`                 | 节点管理子命令（invoke、camera、canvas、screen、pairing） |
| `node-cli/`                  | 无头节点主机（daemon 模式）                               |
| `update-cli/`                | 更新命令（update、status、restart helper）                |
| `browser-cli-actions-input/` | 浏览器自动化操作注册（元素交互、文件下载、表单、导航）    |
| `shared/`                    | 共享工具（端口解析等）                                    |

## 关键文件索引

| 文件                          | 职责                                     |
| ----------------------------- | ---------------------------------------- |
| `run-main.ts`                 | CLI 入口，启动流程编排                   |
| `program.ts`                  | 导出 `buildProgram`，构建 Commander 实例 |
| `program/build-program.ts`    | 组装 Commander 程序                      |
| `program/command-registry.ts` | 核心命令懒加载注册表                     |
| `program/register.subclis.ts` | 子 CLI 命令懒加载注册表                  |
| `route.ts`                    | 快速路由，跳过完整解析                   |
| `deps.ts`                     | 依赖注入工厂（频道发送函数）             |
| `gateway-rpc.ts`              | CLI → Gateway WebSocket RPC 调用         |
| `profile.ts`                  | 多 profile 支持                          |
| `progress.ts`                 | 统一进度显示（OSC + spinner）            |
| `banner.ts`                   | CLI 启动横幅和 ASCII art                 |
| `argv.ts`                     | 参数解析工具                             |
| `cli-utils.ts`                | 通用 CLI 工具函数                        |
| `channel-auth.ts`             | 频道认证流程                             |
| `channels-cli.ts`             | `openclaw channels` 命令                 |
| `config-cli.ts`               | `openclaw config` 命令                   |
| `models-cli.ts`               | `openclaw models` 命令                   |
| `skills-cli.ts`               | `openclaw skills` 命令                   |
| `plugins-cli.ts`              | `openclaw plugins` 命令                  |
| `security-cli.ts`             | `openclaw security` 命令                 |
| `completion-cli.ts`           | Shell 补全脚本生成                       |
| `respawn-policy.ts`           | 进程重启策略                             |
| `command-format.ts`           | 命令格式化工具                           |

## 设计特点

1. 懒加载优先：命令模块按需加载，CLI 启动时间极短
2. 依赖注入：通过 `CliDeps` 解耦频道实现，便于测试
3. RPC 驱动：大部分命令通过 WebSocket RPC 调用 Gateway，CLI 本身是轻量客户端
4. Profile 隔离：支持多实例并行运行
5. 插件扩展：插件可以注册自定义 CLI 命令
6. 跨平台：处理 Windows 参数规范化、PATH 环境等平台差异
