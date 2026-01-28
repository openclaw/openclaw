---
read_when:
  - 在同一台机器上运行多个 Gateway网关
  - 需要为每个 Gateway网关提供独立的配置/状态/端口
summary: 在同一主机上运行多个 OpenClaw Gateway网关（隔离、端口和配置文件）
title: 多个 Gateway网关
x-i18n:
  generated_at: "2026-02-01T20:35:02Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 09b5035d4e5fb97c8d4596f7e23dea67224dad3b6d9e2c37ecb99840f28bd77d
  source_path: gateway/multiple-gateways.md
  workflow: 14
---

# 多个 Gateway网关（同一主机）

大多数场景只需使用一个 Gateway网关，因为单个 Gateway网关可以处理多个消息连接和智能体。如果你需要更强的隔离性或冗余能力（例如救援机器人），请使用独立的配置文件/端口运行多个 Gateway网关。

## 隔离检查清单（必需）

- `OPENCLAW_CONFIG_PATH` — 每个实例独立的配置文件
- `OPENCLAW_STATE_DIR` — 每个实例独立的会话、凭据、缓存
- `agents.defaults.workspace` — 每个实例独立的工作区根目录
- `gateway.port`（或 `--port`）— 每个实例唯一
- 派生端口（浏览器/画布）不得重叠

如果这些配置被共享，将会出现配置竞争和端口冲突。

## 推荐方式：配置文件（`--profile`）

配置文件会自动限定 `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` 的作用域，并为服务名称添加后缀。

```bash
# 主实例
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# 救援实例
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

按配置文件安装服务：

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## 救援机器人指南

在同一主机上运行第二个 Gateway网关，为其配置独立的：

- 配置文件/配置
- 状态目录
- 工作区
- 基础端口（及派生端口）

这样可以将救援机器人与主机器人隔离，使其在主机器人宕机时仍能进行调试或应用配置更改。

端口间隔：基础端口之间至少留出 20 个端口的间距，以确保派生的浏览器/画布/CDP 端口不会冲突。

### 安装方法（救援机器人）

```bash
# 主机器人（已有或全新安装，不使用 --profile 参数）
# 运行在端口 18789 + Chrome CDC/Canvas/... 端口
openclaw onboard
openclaw gateway install

# 救援机器人（独立配置文件 + 端口）
openclaw --profile rescue onboard
# 注意：
# - 工作区名称默认会添加 -rescue 后缀
# - 端口至少应为 18789 + 20 个端口，
#   建议选择完全不同的基础端口，如 19789
# - 其余新手引导流程与正常流程相同

# 安装服务（如果在新手引导过程中未自动安装）
openclaw --profile rescue gateway install
```

## 端口映射（派生）

基础端口 = `gateway.port`（或 `OPENCLAW_GATEWAY_PORT` / `--port`）。

- 浏览器控制服务端口 = 基础端口 + 2（仅限 local loopback）
- `canvasHost.port = 基础端口 + 4`
- 浏览器配置文件 CDP 端口从 `browser.controlPort + 9 .. + 108` 自动分配

如果你在配置或环境变量中覆盖了这些值，必须确保每个实例的值唯一。

## 浏览器/CDP 注意事项（常见陷阱）

- **不要**在多个实例上将 `browser.cdpUrl` 设置为相同的值。
- 每个实例需要独立的浏览器控制端口和 CDP 端口范围（从其 Gateway网关端口派生）。
- 如需显式指定 CDP 端口，请为每个实例设置 `browser.profiles.<name>.cdpPort`。
- 远程 Chrome：使用 `browser.profiles.<name>.cdpUrl`（按配置文件、按实例设置）。

## 手动环境变量示例

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## 快速检查

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
