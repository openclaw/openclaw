---
summary: "网关服务、生命周期和操作的运行手册"
read_when:
  - 运行或调试网关进程
title: "网关运行手册"
---

# 网关运行手册

使用此页面进行网关服务的第 1 天启动和第 2 天操作。

<CardGroup cols={2}>
  <Card title="深度故障排除" icon="siren" href="/gateway/troubleshooting">
    基于症状的诊断，包含确切的命令阶梯和日志签名。
  </Card>
  <Card title="配置" icon="sliders" href="/gateway/configuration">
    面向任务的设置指南 + 完整配置参考。
  </Card>
  <Card title="密钥管理" icon="key-round" href="/gateway/secrets">
    SecretRef 合约、运行时快照行为和迁移/重新加载操作。
  </Card>
  <Card title="密钥计划合约" icon="shield-check" href="/gateway/secrets-plan-contract">
    确切的 `secrets apply` 目标/路径规则和仅引用认证配置文件行为。
  </Card>
</CardGroup>

## 5 分钟本地启动

<Steps>
  <Step title="启动网关">

```bash
openclaw gateway --port 18789
# 调试/跟踪镜像到标准输入输出
openclaw gateway --port 18789 --verbose
# 强制杀死选定端口上的监听器，然后启动
openclaw gateway --force
```

  </Step>

  <Step title="验证服务健康">

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
```

健康基线：`Runtime: running` 和 `RPC probe: ok`。

  </Step>

  <Step title="验证频道就绪">

```bash
openclaw channels status --probe
```

通过可达的网关，这会运行每个账户的实时频道探针和可选审计。
如果网关不可达，CLI 会回退到仅配置的频道摘要，而不是实时探针输出。

  </Step>
</Steps>

<Note>
网关配置重新加载监视活动配置文件路径（从配置文件/状态默认值解析，或在设置 `OPENCLAW_CONFIG_PATH` 时）。
默认模式是 `gateway.reload.mode="hybrid"`。
首次成功加载后，运行中的进程服务活动的内存中配置快照；成功重新加载会原子性地交换该快照。
</Note>

## 运行时模型

- 一个始终开启的进程，用于路由、控制平面和频道连接。
- 单个多路复用端口用于：
  - WebSocket 控制/RPC
  - HTTP API，兼容 OpenAI（`/v1/models`、`/v1/embeddings`、`/v1/chat/completions`、`/v1/responses`、`/tools/invoke`）
  - 控制 UI 和钩子
- 默认绑定模式：`loopback`。
- 默认需要认证。共享密钥设置使用
  `gateway.auth.token` / `gateway.auth.password`（或
  `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`），非回环
  反向代理设置可以使用 `gateway.auth.mode: "trusted-proxy"`。

## 兼容 OpenAI 的端点

OpenClaw 最高杠杆的兼容表面现在是：

- `GET /v1/models`
- `GET /v1/models/{id}`
- `POST /v1/embeddings`
- `POST /v1/chat/completions`
- `POST /v1/responses`

为什么这组端点很重要：

- 大多数 Open WebUI、LobeChat 和 LibreChat 集成首先探测 `/v1/models`。
- 许多 RAG 和记忆管道期望 `/v1/embeddings`。
- 代理原生客户端越来越倾向于 `/v1/responses`。

规划注意事项：

- `/v1/models` 是代理优先的：它返回 `openclaw`、`openclaw/default` 和 `openclaw/<agentId>`。
- `openclaw/default` 是稳定别名，始终映射到配置的默认代理。
- 当您想要后端提供商/模型覆盖时使用 `x-openclaw-model`；否则，所选代理的正常模型和嵌入设置保持控制。

所有这些都在主网关端口上运行，并使用与网关 HTTP API 其余部分相同的受信任操作员认证边界。

### 端口和绑定优先级

| 设置     | 解析顺序                                                      |
| -------- | ------------------------------------------------------------- |
| 网关端口 | `--port` → `OPENCLAW_GATEWAY_PORT` → `gateway.port` → `18789` |
| 绑定模式 | CLI/覆盖 → `gateway.bind` → `loopback`                        |

### 热重载模式

| `gateway.reload.mode` | 行为                       |
| --------------------- | -------------------------- |
| `off`                 | 无配置重新加载             |
| `hot`                 | 仅应用热安全更改           |
| `restart`             | 在需要重新加载的更改时重启 |
| `hybrid` (默认)       | 安全时热应用，需要时重启   |

## 操作员命令集

```bash
openclaw gateway status
openclaw gateway status --deep   # 添加系统级服务扫描
openclaw gateway status --json
openclaw gateway install
openclaw gateway restart
openclaw gateway stop
openclaw secrets reload
openclaw logs --follow
openclaw doctor
```

`gateway status --deep` 用于额外的服务发现（LaunchDaemons/systemd 系统单元/schtasks），不是更深层次的 RPC 健康探针。

## 多个网关（同一主机）

大多数安装应该每台机器运行一个网关。单个网关可以托管多个代理和频道。

只有当您有意想要隔离或救援机器人时，才需要多个网关。

有用的检查：

```bash
openclaw gateway status --deep
openclaw gateway probe
```

预期结果：

- `gateway status --deep` 可以报告 `Other gateway-like services detected (best effort)`
  并在过时的 launchd/systemd/schtasks 安装仍然存在时打印清理提示。
- `gateway probe` 可以在多个目标回答时警告 `multiple reachable gateways`。
- 如果这是有意的，为每个网关隔离端口、配置/状态和工作区根目录。

详细设置：[/gateway/multiple-gateways](/gateway/multiple-gateways)。

## 远程访问

首选：Tailscale/VPN。
备用：SSH 隧道。

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

然后在本地将客户端连接到 `ws://127.0.0.1:18789`。

<Warning>
SSH 隧道不会绕过网关认证。对于共享密钥认证，客户端即使通过隧道仍然
必须发送 `token`/`password`。对于身份承载模式，
请求仍然必须满足该认证路径。
</Warning>

请参阅：[远程网关](/gateway/remote)、[认证](/gateway/authentication)、[Tailscale](/gateway/tailscale)。

## 监督和服务生命周期

使用监督运行以获得类似生产的可靠性。

<Tabs>
  <Tab title="macOS (launchd)">

```bash
openclaw gateway install
openclaw gateway status
openclaw gateway restart
openclaw gateway stop
```

LaunchAgent 标签是 `ai.openclaw.gateway`（默认）或 `ai.openclaw.<profile>`（命名配置文件）。`openclaw doctor` 审计并修复服务配置漂移。

  </Tab>

  <Tab title="Linux (systemd 用户)">

```bash
openclaw gateway install
systemctl --user enable --now openclaw-gateway[-<profile>].service
openclaw gateway status
```

为了在注销后保持持久，启用逗留：

```bash
sudo loginctl enable-linger <user>
```

当您需要自定义安装路径时的手动用户单元示例：

```ini
[Unit]
Description=OpenClaw Gateway
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
TimeoutStopSec=30
TimeoutStartSec=30
SuccessExitStatus=0 143
KillMode=control-group

[Install]
WantedBy=default.target
```

  </Tab>

  <Tab title="Windows (原生)">

```powershell
openclaw gateway install
openclaw gateway status --json
openclaw gateway restart
openclaw gateway stop
```

原生 Windows 管理启动使用名为 `OpenClaw Gateway` 的计划任务
（或命名配置文件的 `OpenClaw Gateway (<profile>)`）。如果计划任务
创建被拒绝，OpenClaw 会回退到指向状态目录内 `gateway.cmd` 的每用户启动文件夹启动器。

  </Tab>

  <Tab title="Linux (系统服务)">

对多用户/始终开启的主机使用系统单元。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

使用与用户单元相同的服务主体，但将其安装在
`/etc/systemd/system/openclaw-gateway[-<profile>].service` 下，并调整
`ExecStart=`（如果您的 `openclaw` 二进制文件位于其他位置）。

  </Tab>
</Tabs>

## 一台主机上的多个网关

大多数设置应该运行 **一个** 网关。
仅在需要严格隔离/冗余时使用多个（例如救援配置文件）。

每个实例的清单：

- 唯一的 `gateway.port`
- 唯一的 `OPENCLAW_CONFIG_PATH`
- 唯一的 `OPENCLAW_STATE_DIR`
- 唯一的 `agents.defaults.workspace`

示例：

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

请参阅：[多个网关](/gateway/multiple-gateways)。

### 开发配置文件快速路径

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
openclaw --dev status
```

默认值包括隔离的状态/配置和基础网关端口 `19001`。

## 协议快速参考（操作员视图）

- 第一个客户端帧必须是 `connect`。
- 网关返回 `hello-ok` 快照（`presence`、`health`、`stateVersion`、`uptimeMs`、限制/策略）。
- `hello-ok.features.methods` / `events` 是保守的发现列表，不是
  每个可调用辅助路由的生成转储。
- 请求：`req(method, params)` → `res(ok/payload|error)`。
- 常见事件包括 `connect.challenge`、`agent`、`chat`、
  `session.message`、`session.tool`、`sessions.changed`、`presence`、`tick`、
  `health`、`heartbeat`、配对/批准生命周期事件和 `shutdown`。

代理运行分为两个阶段：

1. 立即接受确认（`status:"accepted"`）
2. 最终完成响应（`status:"ok"|"error"`），中间有流式 `agent` 事件。

请参阅完整协议文档：[网关协议](/gateway/protocol)。

## 操作检查

### 存活

- 打开 WS 并发送 `connect`。
- 期望带有快照的 `hello-ok` 响应。

### 就绪

```bash
openclaw gateway status
openclaw channels status --probe
openclaw health
```

### 间隙恢复

事件不会重放。在序列间隙时，在继续之前刷新状态（`health`、`system-presence`）。

## 常见失败签名

| 签名                                                           | 可能的问题                                           |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| `refusing to bind gateway ... without auth`                    | 非回环绑定没有有效的网关认证路径                     |
| `another gateway instance is already listening` / `EADDRINUSE` | 端口冲突                                             |
| `Gateway start blocked: set gateway.mode=local`                | 配置设置为远程模式，或本地模式标记在损坏的配置中缺失 |
| `unauthorized` during connect                                  | 客户端和网关之间的认证不匹配                         |

有关完整的诊断阶梯，请使用 [网关故障排除](/gateway/troubleshooting)。

## 安全保证

- 当网关不可用时，网关协议客户端快速失败（无隐式直接频道回退）。
- 无效/非连接的第一个帧被拒绝并关闭。
- 优雅关闭在套接字关闭前发出 `shutdown` 事件。

---

相关：

- [故障排除](/gateway/troubleshooting)
- [后台进程](/gateway/background-process)
- [配置](/gateway/configuration)
- [健康](/gateway/health)
- [Doctor](/gateway/doctor)
- [认证](/gateway/authentication)
