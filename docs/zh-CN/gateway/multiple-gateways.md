---
read_when:
  - 在同一台机器上运行多个 Gateway 网关
  - 你需要为每个 Gateway 网关隔离配置/状态/端口
summary: 在一台主机上运行多个 OpenClaw Gateway 网关（隔离、端口和配置档案）
title: 多个 Gateway 网关
x-i18n:
  generated_at: "2026-03-16T06:23:07Z"
  model: gpt-5.4
  provider: openai
  source_hash: 98c14bed7b7447481325d60ac379846ae379326400c4b0ed7f8d320ad8c50080
  source_path: gateway/multiple-gateways.md
  workflow: 15
---

# 多个 Gateway 网关（同一主机）

大多数设置应使用一个 Gateway 网关，因为单个 Gateway 网关可以处理多个消息连接和智能体。如果你需要更强的隔离或冗余（例如救援机器人），请运行使用隔离配置档案/端口的独立 Gateway 网关。

## 隔离检查清单（必需）

- `OPENCLAW_CONFIG_PATH` — 每个实例单独的配置文件
- `OPENCLAW_STATE_DIR` — 每个实例单独的会话、凭证、缓存
- `agents.defaults.workspace` — 每个实例单独的工作区根目录
- `gateway.port`（或 `--port`）— 每个实例唯一
- 派生端口（browser/canvas）不得重叠

如果这些被共享，你会遇到配置竞争和端口冲突。

## 推荐：配置档案（`--profile`）

配置档案会自动限定 `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH`，并为服务名称添加后缀。

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

每个配置档案的服务：

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## 救援机器人指南

在同一主机上运行第二个 Gateway 网关，并为它单独设置：

- 配置档案/配置
- 状态目录
- 工作区
- 基础端口（以及派生端口）

这样可以将救援机器人与主机器人隔离，因此当主机器人宕机时，它仍可用于调试或应用配置更改。

端口间距：基础端口之间至少保留 20 个端口，以确保派生的 browser/canvas/CDP 端口永不冲突。

### 如何安装（救援机器人）

```bash
# Main bot（现有或全新，不带 --profile 参数）
# 运行在端口 18789 + Chrome CDC/Canvas/... 端口
openclaw onboard
openclaw gateway install

# Rescue bot（隔离的配置档案 + 端口）
openclaw --profile rescue onboard
# 说明：
# - 工作区名称默认会追加 -rescue 后缀
# - 端口至少应为 18789 + 20 个端口，
#   最好选择完全不同的基础端口，例如 19789，
# - 其余新手引导与正常情况相同

# 安装服务（如果设置期间未自动完成）
openclaw --profile rescue gateway install
```

## 端口映射（派生）

基础端口 = `gateway.port`（或 `OPENCLAW_GATEWAY_PORT` / `--port`）。

- browser 控制服务端口 = 基础端口 + 2（仅 loopback）
- canvas host 由 Gateway 网关 HTTP 服务器提供（与 `gateway.port` 使用相同端口）
- Browser profile CDP 端口会从 `browser.controlPort + 9 .. + 108` 自动分配

如果你在配置或环境变量中覆盖了其中任何一个，必须确保它们在每个实例之间保持唯一。

## Browser/CDP 说明（常见陷阱）

- **不要**在多个实例上将 `browser.cdpUrl` 固定为相同值。
- 每个实例都需要自己的 browser 控制端口和 CDP 范围（从其 Gateway 网关端口派生）。
- 如果你需要显式 CDP 端口，请为每个实例设置 `browser.profiles.<name>.cdpPort`。
- 远程 Chrome：使用 `browser.profiles.<name>.cdpUrl`（按配置档案、按实例设置）。

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
