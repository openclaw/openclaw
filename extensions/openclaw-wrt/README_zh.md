# OpenClaw WRT

OpenClaw 路由器设备桥接插件，通过 WebSocket 控制 ClawWRT 路由器设备。

**[English](README.md)**

## 功能特性

- WebSocket 桥接服务端，接收路由器设备连接
- 通过 `req_id` 实现请求/响应关联
- 设备会话管理（连接、认证、超时、别名）
- AWAS 认证代理（将 cloud 模式设备的 connect/heartbeat 转发到 AWAS 服务器）
- 30+ 细粒度工具，覆盖：WiFi 配置、客户端管理、BPF 流量监控、WireGuard VPN、Shell 执行、portal 页面发布、域名信任列表等

## 安装

### 方式一：npm 安装（发布后）

```bash
openclaw plugins install @openclaw/openclaw-wrt
```

### 方式二：本地目录安装（推荐开发调试）

无需构建，直接将源码目录安装到 OpenClaw 中：

```bash
openclaw plugins install /path/to/openclaw-wrt
```

示例：

```bash
openclaw plugins install /home/user/work/openclaw-wrt
```

> OpenClaw 会自动将插件链接到 `~/.openclaw/extensions/` 目录下，并通过 jiti 编译 TypeScript 源码加载。

### 方式三：构建后本地安装

```bash
# 先构建
pnpm build

# 安装构建产物
openclaw plugins install /path/to/openclaw-wrt
```

### 验证安装

```bash
# 查看已安装插件列表
openclaw plugins list

# 查看插件详情
openclaw plugins inspect openclaw-wrt
```

### 卸载

```bash
openclaw plugins remove openclaw-wrt
```

## 工作原理

```
┌──────────────┐    WebSocket     ┌──────────────────┐    Tool calls    ┌──────────────────┐
│   ClawWRT    │ ──────────────>  │  OpenClaw WRT    │ ──────────────>  │  OpenClaw Agent  │
│   路由器     │ <──────────────  │  Bridge Plugin   │ <──────────────  │  (LLM)           │
│   设备       │    JSON-RPC      │                  │                  │                  │
│              │                  │  · req_id 关联   │                  │  通过 30+ 工具   │
└──────────────┘                  │  · 设备管理      │                  │  管理路由器      │
                                  │  · 认证/令牌     │                  └──────────────────┘
                                  │  · AWAS 代理     │
                                  └──────────────────┘
```

1. **路由器连接** — 每台 ClawWRT 路由器通过 WebSocket 连接到桥接服务（`ws://host:8001/ws/clawwrt`），并发送包含 `device_id` 的连接消息。
2. **桥接管理会话** — 插件维护一个设备注册表，记录连接状态、别名，并支持可选的令牌认证。
3. **Agent 控制设备** — OpenClaw 的 LLM Agent 调用 30+ 已注册的工具（如 `clawwrt_get_clients`、`clawwrt_set_wifi_info`、`clawwrt_exec_shell`）。每次工具调用通过 `req_id` 与路由器的响应关联。
4. **AWAS 代理（可选）** — 对于 cloud 模式设备，插件可以将认证流量转发到 AWAS（认证服务器）后端。

## Portal 页面

在 Agent 已根据用户 prompt 生成 portal HTML 之后，使用 `clawwrt_publish_portal_page` 将页面写入宿主机 nginx 的 web 目录，并保存为设备专属 HTML 文件，随后更新已连接路由器，让 ApFree WiFiDog 将用户重定向到该页面。

页面应尽量保持自包含。除非你明确知道 nginx web 目录还会提供额外资源，否则建议把 CSS 和 JavaScript 内联到 HTML 中。

## 配置项

| 配置项             | 说明                    | 默认值        |
| ------------------ | ----------------------- | ------------- |
| `enabled`          | 启用桥接                | `true`        |
| `bind`             | 绑定地址                | `127.0.0.1`   |
| `port`             | 桥接端口                | `8001`        |
| `path`             | WebSocket 路径          | `/ws/clawwrt` |
| `allowDeviceIds`   | 允许的设备 ID（白名单） | _(任意)_      |
| `requestTimeoutMs` | 默认请求超时（毫秒）    | `10000`       |
| `maxPayloadBytes`  | 最大负载字节数          | `262144`      |
| `token`            | 设备认证令牌            | `clawwrt`     |
| `awasEnabled`      | 启用 AWAS 认证代理      | `false`       |
| `awasHost`         | AWAS 服务器主机名       | `127.0.0.1`   |
| `awasPort`         | AWAS 服务器端口         | `80`          |
| `awasPath`         | AWAS WebSocket 路径     | `/ws/clawwrt` |
| `awasSsl`          | 使用 TLS (wss://)       | `false`       |

### 工具白名单说明

如果你的 OpenClaw 配置使用了较严格的工具配置，例如：

```json
{
  "tools": {
    "profile": "coding"
  }
}
```

那么内置的 `coding` profile 默认只允许核心 coding 工具，不会自动放行 `openclaw-wrt` 这样的插件工具。插件虽然已经加载，但 Agent 可能无法真正调用这些工具。

建议配置为：

```json
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["openclaw-wrt"]
  }
}
```

原因如下：

- `coding` 是核心工具白名单，不是插件工具白名单
- `alsoAllow: ["openclaw-wrt"]` 会展开并放行本插件注册的工具
- 如果不加这项，Agent 可能“知道有这个插件”，但无法实际调用 `clawwrt_list_devices`、`clawwrt_get_status`、`clawwrt_get_clients` 等工具

## 开发

```bash
# 安装依赖
pnpm install

# 构建
pnpm build

# 监听模式
pnpm dev
```

## 许可证

MIT
