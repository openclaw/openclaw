---
title: OpenShell
summary: "使用 OpenShell 作为 OpenClaw 代理的托管沙箱后端"
read_when:
  - 您想要云托管沙箱而不是本地 Docker
  - 您正在设置 OpenShell 插件
  - 您需要在 mirror 和 remote 工作区模式之间进行选择
---

# OpenShell

OpenShell 是 OpenClaw 的托管沙箱后端。不再在本地运行 Docker 容器，OpenClaw 将沙箱生命周期委托给 `openshell` CLI，它通过 SSH 远程环境提供支持。

OpenShell 插件重用了与通用 [SSH 后端](/gateway/sandboxing#ssh-backend) 相同的核心 SSH 传输和远程文件系统桥。它添加了 OpenShell 特定的生命周期（`sandbox create/get/delete`、`sandbox ssh-config`）和一个可选的 `mirror` 工作区模式。

## 前提条件

- `openshell` CLI 已安装并在 `PATH` 上（或通过 `plugins.entries.openshell.config.command` 设置自定义路径）
- 具有沙箱访问权限的 OpenClaw 账户
- 在主机上运行的 OpenClaw Gateway

## 快速开始

1. 启用插件并设置沙箱后端：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "openshell",
        scope: "session",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      openshell: {
        enabled: true,
        config: {
          from: "openclaw",
          mode: "remote",
        },
      },
    },
  },
}
```

2. 重启 Gateway。在下一个代理轮次，OpenClaw 创建一个 OpenShell 沙箱并通过它路由工具执行。

3. 验证：

```bash
openclaw sandbox list
openclaw sandbox explain
```

## 工作区模式

这是使用 OpenShell 时最重要的决定。

### `mirror`

当您希望**本地工作区保持权威**时，使用 `plugins.entries.openshell.config.mode: "mirror"`。

行为：

- 在 `exec` 之前，OpenClaw 将本地工作区同步到 OpenShell 沙箱。
- 在 `exec` 之后，OpenClaw 将远程工作区同步回本地工作区。
- 文件工具仍然通过沙箱桥操作，但本地工作区在轮次之间保持为数据源。

最适合：

- 您在 OpenClaw 之外本地编辑文件，并希望这些更改自动在沙箱中可见。
- 您希望 OpenShell 沙箱尽可能像 Docker 后端一样行为。
- 您希望主机工作区在每个 exec 轮次后反映沙箱写入。

权衡：每次 exec 前后都有额外的同步开销。

### `remote`

当您希望 **OpenShell 工作区成为权威**时，使用 `plugins.entries.openshell.config.mode: "remote"`。

行为：

- 首次创建沙箱时，OpenClaw 从本地工作区一次性播种远程工作区。
- 之后，`exec`、`read`、`write`、`edit` 和 `apply_patch` 直接针对远程 OpenShell 工作区操作。
- OpenClaw **不会**将远程更改同步回本地工作区。
- 提示时的媒体读取仍然有效，因为文件和媒体工具通过沙箱桥读取。

最适合：

- 沙箱主要存在于远程端。
- 您希望降低每轮同步开销。
- 您不希望主机本地编辑静默覆盖远程沙箱状态。

重要：如果在初始播种后在主机上在 OpenClaw 之外编辑文件，远程沙箱 **不会**看到这些更改。使用 `openclaw sandbox recreate` 重新播种。

### 选择模式

| | `mirror` | `remote` |
| ------------------------ | -------------------------- | ------------------------- |
| **权威工作区** | 本地主机 | 远程 OpenShell |
| **同步方向** | 双向（每次 exec） | 一次性播种 |
| **每轮开销** | 更高（上传 + 下载） | 更低（直接远程操作） |
| **本地编辑可见？** | 是，在下次 exec 时 | 否，直到 recreate |
| **最适合** | 开发工作流 | 长时间运行的代理、CI |

## 配置参考

所有 OpenShell 配置位于 `plugins.entries.openshell.config` 下：

| 键 | 类型 | 默认值 | 描述 |
| ------------------------- | ------------------------ | ------------- | ----------------------------------------------------- |
| `mode` | `"mirror"` 或 `"remote"` | `"mirror"` | 工作区同步模式 |
| `command` | `string` | `"openshell"` | `openshell` CLI 的路径或名称 |
| `from` | `string` | `"openclaw"` | 首次创建时的沙箱源 |
| `gateway` | `string` | — | OpenShell 网关名称（`--gateway`）|
| `gatewayEndpoint` | `string` | — | OpenShell 网关端点 URL（`--gateway-endpoint`）|
| `policy` | `string` | — | 沙箱创建的 OpenShell 策略 ID |
| `providers` | `string[]` | `[]` | 创建沙箱时要附加的提供商名称 |
| `gpu` | `boolean` | `false` | 请求 GPU 资源 |
| `autoProviders` | `boolean` | `true` | 在沙箱创建期间传递 `--auto-providers` |
| `remoteWorkspaceDir` | `string` | `"/sandbox"` | 沙箱内的主要可写工作区 |
| `remoteAgentWorkspaceDir` | `string` | `"/agent"` | 代理工作区挂载路径（用于只读访问）|
| `timeoutSeconds` | `number` | `120` | `openshell` CLI 操作的超时时间 |

沙箱级设置（`mode`、`scope`、`workspaceAccess`）在 `agents.defaults.sandbox` 下配置，与任何后端相同。请参阅 [沙箱](/gateway/sandboxing) 获取完整矩阵。

## 示例

### 最小 remote 设置

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "openshell",
      },
    },
  },
  plugins: {
    entries: {
      openshell: {
        enabled: true,
        config: {
          from: "openclaw",
          mode: "remote",
        },
      },
    },
  },
}
```

### 带 GPU 的 Mirror 模式

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "openshell",
        scope: "agent",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      openshell: {
        enabled: true,
        config: {
          from: "openclaw",
          mode: "mirror",
          gpu: true,
          providers: ["openai"],
          timeoutSeconds: 180,
        },
      },
    },
  },
}
```

### 每个代理的 OpenShell 和自定义网关

```json5
{
  agents: {
    defaults: {
      sandbox: { mode: "off" },
    },
    list: [
      {
        id: "researcher",
        sandbox: {
          mode: "all",
          backend: "openshell",
          scope: "agent",
          workspaceAccess: "rw",
        },
      },
    ],
  },
  plugins: {
    entries: {
      openshell: {
        enabled: true,
        config: {
          from: "openclaw",
          mode: "remote",
          gateway: "lab",
          gatewayEndpoint: "https://lab.example",
          policy: "strict",
        },
      },
    },
  },
}
```

## 生命周期管理

OpenShell 沙箱通过常规沙箱 CLI 管理：

```bash
# 列出所有沙箱运行时（Docker + OpenShell）
openclaw sandbox list

# 检查有效策略
openclaw sandbox explain

# 重新创建（删除远程工作区，下次使用时重新播种）
openclaw sandbox recreate --all
```

对于 `remote` 模式，**重新创建特别重要**：它删除该范围的权威远程工作区。下次使用时从本地工作区播种新的远程工作区。

对于 `mirror` 模式，重新创建主要重置远程执行环境，因为本地工作区保持权威。

### 何时重新创建

更改以下任何一项后重新创建：

- `agents.defaults.sandbox.backend`
- `plugins.entries.openshell.config.from`
- `plugins.entries.openshell.config.mode`
- `plugins.entries.openshell.config.policy`

```bash
openclaw sandbox recreate --all
```

## 当前限制

- 沙箱浏览器在 OpenShell 后端上不支持。
- `sandbox.docker.binds` 不适用于 OpenShell。
- `sandbox.docker.*` 下的 Docker 特定运行时旋钮仅适用于 Docker 后端。

## 工作原理

1. OpenClaw 调用 `openshell sandbox create`（带有配置的 `--from`、`--gateway`、`--policy`、`--providers`、`--gpu` 标志）。
2. OpenClaw 调用 `openshell sandbox ssh-config <name>` 获取沙箱的 SSH 连接详情。
3. 核心将 SSH 配置写入临时文件，并使用与通用 SSH 后端相同的远程文件系统桥打开 SSH 会话。
4. 在 `mirror` 模式：exec 前同步本地到远程，exec 后同步回。
5. 在 `remote` 模式：创建时一次性播种，然后直接对远程工作区操作。

## 另请参阅

- [沙箱](/gateway/sandboxing) — 模式、范围和后端比较
- [沙箱 vs 工具策略 vs 提升](/gateway/sandbox-vs-tool-policy-vs-elevated) — 调试被阻止的工具
- [多代理沙箱和工具](/tools/multi-agent-sandbox-tools) — 每个代理的覆盖
- [沙箱 CLI](/cli/sandbox) — `openclaw sandbox` 命令