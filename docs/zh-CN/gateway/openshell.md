---
title: OpenShell
summary: "将 OpenShell 作为 OpenClaw 智能体的托管沙箱后端使用"
read_when:
  - 你想要云托管沙箱而不是本地 Docker
  - 你正在设置 OpenShell 插件
  - 你需要在 mirror 和 remote 工作区模式之间选择
---

# OpenShell

OpenShell 是 OpenClaw 的托管沙箱后端。OpenClaw 不在本地运行 Docker 容器，而是将沙箱生命周期委托给 `openshell` CLI，该 CLI 通过 SSH 基础的命令执行来配置远程环境。

OpenShell 插件复用了与通用 [SSH 后端](/gateway/sandboxing#ssh-backend) 相同的核心 SSH 传输和远程文件系统桥接。它添加了 OpenShell 特定的生命周期（`sandbox create/get/delete`、`sandbox ssh-config`）和可选的 `mirror` 工作区模式。

## 前提条件

- 已安装 `openshell` CLI 并在 `PATH` 上（或通过 `plugins.entries.openshell.config.command` 设置自定义路径）
- 具有沙箱访问权限的 OpenShell 账户
- 主机上运行 OpenClaw Gateway

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

2. 重启 Gateway。在下一个智能体回合，OpenClaw 会创建一个 OpenShell 沙箱并通过它路由工具执行。

3. 验证：

```bash
openclaw sandbox list
openclaw sandbox explain
```

## 工作区模式

这是使用 OpenShell 时最重要的决定。

### `mirror`

当你想要**本地工作区保持权威**时，使用 `plugins.entries.openshell.config.mode: "mirror"`。

行为：

- 在 `exec` 之前，OpenClaw 将本地工作区同步到 OpenShell 沙箱。
- 在 `exec` 之后，OpenClaw 将远程工作区同步回本地工作区。
- 文件工具仍然通过沙箱桥接操作，但本地工作区在回合之间仍然是数据源。

最适合：

- 你在 OpenClaw 外部本地编辑文件，并希望这些更改自动在沙箱中可见。
- 你想让 OpenShell 沙箱的行为尽可能像 Docker 后端。
- 你希望主机工作区在每次 exec 回合后反映沙箱写入。

权衡：每次 exec 前后有额外的同步开销。

### `remote`

当你想要**OpenShell 工作区成为权威**时，使用 `plugins.entries.openshell.config.mode: "remote"`。

行为：

- 当沙箱首次创建时，OpenClaw 从本地工作区一次性种子远程工作区。
- 之后，`exec`、`read`、`write`、`edit` 和 `apply_patch` 直接对远程 OpenShell 工作区操作。
- OpenClaw **不会**将远程更改同步回本地工作区。
- 提示时的媒体读取仍然有效，因为文件和媒体工具通过沙箱桥接读取。

最适合：

- 沙箱应主要存在于远程端。
- 你想要更低的每回合同步开销。
- 你不希望主机本地编辑静默覆盖远程沙箱状态。

重要提示：如果你在初始种子后在主机上编辑文件，远程沙箱**不会**看到这些更改。使用 `openclaw sandbox recreate` 重新种子。

### 选择模式

|                          | `mirror`                   | `remote`                  |
| ------------------------ | -------------------------- | ------------------------- |
| **权威工作区**           | 本地主机                   | 远程 OpenShell            |
| **同步方向**             | 双向（每次 exec）          | 一次性种子                |
| **每回合开销**           | 较高（上传 + 下载）        | 较低（直接远程操作）      |
| **本地编辑可见？**       | 是，下一次 exec            | 否，直到 recreate         |
| **最适合**               | 开发工作流                  | 长期运行的智能体、CI      |

## 配置参考

所有 OpenShell 配置都在 `plugins.entries.openshell.config` 下：

| 键                        | 类型                      | 默认值        | 描述                                           |
| ------------------------- | ------------------------- | ------------- | ------------------------------------------------ |
| `mode`                    | `"mirror"` 或 `"remote"`  | `"mirror"`    | 工作区同步模式                                   |
| `command`                 | `string`                  | `"openshell"` | `openshell` CLI 的路径或名称                   |
| `from`                    | `string`                  | `"openclaw"`  | 首次创建时的沙箱源                  |
| `gateway`                 | `string`                  | —             | OpenShell gateway 名称 (`--gateway`)                  |
| `gatewayEndpoint`         | `string`                  | —             | OpenShell gateway 端点 URL (`--gateway-endpoint`) |
| `policy`                  | `string`                  | —             | 沙箱创建的 OpenShell policy ID              |
| `providers`               | `string[]`                | `[]`          | 沙箱创建时附加的提供者名称      |
| `gpu`                     | `boolean`                 | `false`       | 请求 GPU 资源                                 |
| `autoProviders`           | `boolean`                 | `true`        | 沙箱创建时传递 `--auto-providers`         |
| `remoteWorkspaceDir`      | `string`                  | `"/sandbox"`  | 沙箱内的主要可写工作区         |
| `remoteAgentWorkspaceDir` | `string`                  | `"/agent"`    | 智能体工作区挂载路径（用于只读访问）     |
| `timeoutSeconds`          | `number`                  | `120`         | `openshell` CLI 操作的超时                |

沙箱级别设置（`mode`、`scope`、`workspaceAccess`）像任何后端一样在 `agents.defaults.sandbox` 下配置。请参阅 [沙箱](/gateway/sandboxing) 以了解完整矩阵。

## 示例

### 最小远程设置

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

### 带自定义 gateway 的每个智能体 OpenShell

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

OpenShell 沙箱通过正常的沙箱 CLI 管理：

```bash
# 列出所有沙箱运行时（Docker + OpenShell）
openclaw sandbox list

# 检查有效策略
openclaw sandbox explain

# 重建（删除远程工作区，下次使用时重新种子）
openclaw sandbox recreate --all
```

对于 `remote` 模式，**重建特别重要**：它会删除该范围的权威远程工作区。下次使用会从本地工作区种子一个全新的远程工作区。

对于 `mirror` 模式，重建主要重置远程执行环境，因为本地工作区仍然是权威。

### 何时重建

在更改以下任何内容后重建：

- `agents.defaults.sandbox.backend`
- `plugins.entries.openshell.config.from`
- `plugins.entries.openshell.config.mode`
- `plugins.entries.openshell.config.policy`

```bash
openclaw sandbox recreate --all
```

## 当前限制

- OpenShell 后端不支持沙箱浏览器。
- `sandbox.docker.binds` 不适用于 OpenShell。
- `sandbox.docker.*` 下的 Docker 特定运行时参数仅适用于 Docker 后端。

## 工作原理

1. OpenClaw 调用 `openshell sandbox create`（根据配置使用 `--from`、`--gateway`、`--policy`、`--providers`、`--gpu` 标志）。
2. OpenClaw 调用 `openshell sandbox ssh-config <name>` 获取沙箱的 SSH 连接详情。
3. Core 将 SSH 配置写入临时文件，并使用与通用 SSH 后端相同的远程文件系统桥接打开 SSH 会话。
4. 在 `mirror` 模式：exec 前同步本地到远程，运行，exec 后同步回本地。
5. 在 `remote` 模式：创建时一次性种子，然后直接在远程工作区上操作。

## 另请参阅

- [沙箱](/gateway/sandboxing) —— 模式、范围和后端比较
- [沙箱 vs 工具策略 vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) —— 调试被阻止的工具
- [多智能体沙箱和工具](/tools/multi-agent-sandbox-tools) —— 每个智能体覆盖
- [沙箱 CLI](/cli/sandbox) —— `openclaw sandbox` 命令