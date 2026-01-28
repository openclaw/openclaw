---
read_when: 你想深入了解沙箱机制，或需要调整 agents.defaults.sandbox 配置。
status: active
summary: OpenClaw 沙箱的工作原理：模式、作用域、工作区访问和镜像
title: 沙箱
x-i18n:
  generated_at: "2026-02-01T20:38:47Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 184fc53001fc6b2847bbb1963cc9c54475d62f74555a581a262a448a0333a209
  source_path: gateway/sandboxing.md
  workflow: 14
---

# 沙箱

OpenClaw 可以**在 Docker 容器内运行工具**以缩小影响范围。
此功能是**可选的**，通过配置控制（`agents.defaults.sandbox` 或
`agents.list[].sandbox`）。如果沙箱未启用，工具将在宿主机上运行。
Gateway网关始终在宿主机上运行；启用沙箱后，工具执行将在隔离的沙箱中进行。

这并非完美的安全边界，但在模型执行了错误操作时，能有效限制文件系统和进程访问。

## 哪些内容会被沙箱隔离

- 工具执行（`exec`、`read`、`write`、`edit`、`apply_patch`、`process` 等）。
- 可选的沙箱浏览器（`agents.defaults.sandbox.browser`）。
  - 默认情况下，沙箱浏览器会在浏览器工具需要时自动启动（确保 CDP 可达）。
    通过 `agents.defaults.sandbox.browser.autoStart` 和 `agents.defaults.sandbox.browser.autoStartTimeoutMs` 进行配置。
  - `agents.defaults.sandbox.browser.allowHostControl` 允许沙箱会话显式访问宿主机浏览器。
  - 可选的允许列表控制 `target: "custom"`：`allowedControlUrls`、`allowedControlHosts`、`allowedControlPorts`。

未被沙箱隔离的内容：

- Gateway网关进程本身。
- 任何被显式允许在宿主机上运行的工具（例如 `tools.elevated`）。
  - **提权 exec 在宿主机上运行，会绕过沙箱。**
  - 如果沙箱未启用，`tools.elevated` 不会改变执行方式（本身已在宿主机上）。参见[提权模式](/tools/elevated)。

## 模式

`agents.defaults.sandbox.mode` 控制**何时**使用沙箱：

- `"off"`：不使用沙箱。
- `"non-main"`：仅对**非主**会话启用沙箱（如果你希望普通聊天在宿主机上运行，这是默认值）。
- `"all"`：所有会话都在沙箱中运行。
  注意：`"non-main"` 基于 `session.mainKey`（默认为 `"main"`），而非智能体 ID。
  群组/渠道会话使用各自的键，因此它们被视为非主会话，会被沙箱隔离。

## 作用域

`agents.defaults.sandbox.scope` 控制**创建多少个容器**：

- `"session"`（默认）：每个会话一个容器。
- `"agent"`：每个智能体一个容器。
- `"shared"`：所有沙箱会话共享一个容器。

## 工作区访问

`agents.defaults.sandbox.workspaceAccess` 控制**沙箱能看到什么**：

- `"none"`（默认）：工具在 `~/.openclaw/sandboxes` 下的沙箱工作区中运行。
- `"ro"`：以只读方式将智能体工作区挂载到 `/agent`（禁用 `write`/`edit`/`apply_patch`）。
- `"rw"`：以读写方式将智能体工作区挂载到 `/workspace`。

入站媒体会被复制到活动沙箱工作区中（`media/inbound/*`）。
Skills 说明：`read` 工具以沙箱为根目录。当 `workspaceAccess: "none"` 时，
OpenClaw 会将符合条件的 Skills 镜像到沙箱工作区（`.../skills`）中以便读取。当设为 `"rw"` 时，工作区 Skills 可从
`/workspace/skills` 读取。

## 自定义绑定挂载

`agents.defaults.sandbox.docker.binds` 将额外的宿主机目录挂载到容器中。
格式：`host:container:mode`（例如 `"/home/user/source:/source:rw"`）。

全局和每个智能体的绑定挂载会被**合并**（而非替换）。在 `scope: "shared"` 下，每个智能体的绑定挂载会被忽略。

示例（只读源码 + Docker 套接字）：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

安全注意事项：

- 绑定挂载会绕过沙箱文件系统：它们以你设置的模式（`:ro` 或 `:rw`）暴露宿主机路径。
- 敏感挂载（例如 `docker.sock`、密钥、SSH 密钥）应使用 `:ro`，除非确实需要写入。
- 如果你只需要对工作区的读取权限，可与 `workspaceAccess: "ro"` 配合使用；绑定模式保持独立。
- 参见[沙箱 vs 工具策略 vs 提权](/gateway/sandbox-vs-tool-policy-vs-elevated)了解绑定挂载如何与工具策略和提权 exec 交互。

## 镜像 + 设置

默认镜像：`openclaw-sandbox:bookworm-slim`

构建一次即可：

```bash
scripts/sandbox-setup.sh
```

注意：默认镜像**不包含** Node。如果 Skills 需要 Node（或
其他运行时），请构建自定义镜像或通过
`sandbox.docker.setupCommand` 安装（需要网络出口 + 可写根文件系统 +
root 用户）。

沙箱浏览器镜像：

```bash
scripts/sandbox-browser-setup.sh
```

默认情况下，沙箱容器以**无网络**方式运行。
可通过 `agents.defaults.sandbox.docker.network` 覆盖。

Docker 安装和容器化 Gateway网关的说明在这里：
[Docker](/install/docker)

## setupCommand（一次性容器设置）

`setupCommand` 在沙箱容器创建后**仅运行一次**（不会每次运行时都执行）。
它通过 `sh -lc` 在容器内执行。

路径：

- 全局：`agents.defaults.sandbox.docker.setupCommand`
- 每个智能体：`agents.list[].sandbox.docker.setupCommand`

常见问题：

- 默认 `docker.network` 为 `"none"`（无出口），因此包安装会失败。
- `readOnlyRoot: true` 会阻止写入；请设置 `readOnlyRoot: false` 或构建自定义镜像。
- 包安装需要 root 用户（省略 `user` 或设置 `user: "0:0"`）。
- 沙箱 exec **不会**继承宿主机的 `process.env`。请使用
  `agents.defaults.sandbox.docker.env`（或自定义镜像）来设置 Skills API 密钥。

## 工具策略 + 逃逸机制

工具的允许/拒绝策略仍在沙箱规则之前生效。如果某个工具在全局或智能体级别被拒绝，沙箱不会将其恢复。

`tools.elevated` 是一个显式的逃逸机制，在宿主机上运行 `exec`。
`/exec` 指令仅对授权发送者生效，且在每个会话中持续有效；要彻底禁用
`exec`，请使用工具策略拒绝（参见[沙箱 vs 工具策略 vs 提权](/gateway/sandbox-vs-tool-policy-vs-elevated)）。

调试：

- 使用 `openclaw sandbox explain` 检查当前生效的沙箱模式、工具策略和修复配置项。
- 参见[沙箱 vs 工具策略 vs 提权](/gateway/sandbox-vs-tool-policy-vs-elevated)了解"为什么被阻止了？"的思维模型。
  保持锁定状态。

## 多智能体覆盖

每个智能体可以覆盖沙箱和工具配置：
`agents.list[].sandbox` 和 `agents.list[].tools`（以及 `agents.list[].tools.sandbox.tools` 用于沙箱工具策略）。
参见[多智能体沙箱与工具](/multi-agent-sandbox-tools)了解优先级。

## 最小启用示例

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## 相关文档

- [沙箱配置](/gateway/configuration#agentsdefaults-sandbox)
- [多智能体沙箱与工具](/multi-agent-sandbox-tools)
- [安全](/gateway/security)
