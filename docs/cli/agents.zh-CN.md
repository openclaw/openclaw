---
summary: "`openclaw agents` 的 CLI 参考（list/add/delete/bindings/bind/unbind/set identity）"
read_when:
  - 您想要多个隔离的代理（工作区 + 路由 + 身份验证）

title: "agents"
---

# `openclaw agents`

管理隔离的代理（工作区 + 身份验证 + 路由）。

相关：

- 多代理路由：[多代理路由](/concepts/multi-agent)
- 代理工作区：[代理工作区](/concepts/agent-workspace)
- 技能可见性配置：[技能配置](/tools/skills-config)

## 示例

```bash
openclaw agents list
openclaw agents list --bindings
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents add ops --workspace ~/.openclaw/workspace-ops --bind telegram:ops --non-interactive
openclaw agents bindings
openclaw agents bind --agent work --bind telegram:ops
openclaw agents unbind --agent work --bind telegram:ops
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## 路由绑定

使用路由绑定将入站通道流量固定到特定代理。

如果您还希望每个代理有不同的可见技能，请在 `openclaw.json` 中配置
`agents.defaults.skills` 和 `agents.list[].skills`。请参阅
[技能配置](/tools/skills-config) 和
[配置参考](/gateway/configuration-reference#agents-defaults-skills)。

列出绑定：

```bash
openclaw agents bindings
openclaw agents bindings --agent work
openclaw agents bindings --json
```

添加绑定：

```bash
openclaw agents bind --agent work --bind telegram:ops --bind discord:guild-a
```

如果您省略 `accountId`（`--bind <channel>`），OpenClaw 会在可用时从通道默认值和插件设置钩子中解析它。

如果您为 `bind` 或 `unbind` 省略 `--agent`，OpenClaw 会以当前默认代理为目标。

### 绑定范围行为

- 没有 `accountId` 的绑定仅匹配通道默认账户。
- `accountId: "*"` 是通道范围的回退（所有账户），比显式账户绑定的特异性低。
- 如果同一代理已经有一个没有 `accountId` 的匹配通道绑定，并且您后来使用显式或解析的 `accountId` 进行绑定，OpenClaw 会原地升级该现有绑定，而不是添加重复项。

示例：

```bash
# 初始仅通道绑定
openclaw agents bind --agent work --bind telegram

# 稍后升级到账户范围绑定
openclaw agents bind --agent work --bind telegram:ops
```

升级后，该绑定的路由范围为 `telegram:ops`。如果您还需要默认账户路由，请显式添加它（例如 `--bind telegram:default`）。

移除绑定：

```bash
openclaw agents unbind --agent work --bind telegram:ops
openclaw agents unbind --agent work --all
```

`unbind` 接受 `--all` 或一个或多个 `--bind` 值，不能同时接受两者。

## 命令界面

### `agents`

运行不带子命令的 `openclaw agents` 等同于 `openclaw agents list`。

### `agents list`

选项：

- `--json`
- `--bindings`: 包含完整的路由规则，而不仅仅是每个代理的计数/摘要

### `agents add [name]`

选项：

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>`（可重复）
- `--non-interactive`
- `--json`

注意：

- 传递任何显式添加标志会将命令切换到非交互路径。
- 非交互模式需要代理名称和 `--workspace`。
- `main` 是保留的，不能用作新代理 id。

### `agents bindings`

选项：

- `--agent <id>`
- `--json`

### `agents bind`

选项：

- `--agent <id>`（默认为当前默认代理）
- `--bind <channel[:accountId]>`（可重复）
- `--json`

### `agents unbind`

选项：

- `--agent <id>`（默认为当前默认代理）
- `--bind <channel[:accountId]>`（可重复）
- `--all`
- `--json`

### `agents delete <id>`

选项：

- `--force`
- `--json`

注意：

- `main` 不能被删除。
- 没有 `--force`，需要交互式确认。
- 工作区、代理状态和会话转录目录被移到回收站，而不是硬删除。

## 身份文件

每个代理工作区可以在工作区根目录包含一个 `IDENTITY.md`：

- 示例路径：`~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` 从工作区根目录（或显式的 `--identity-file`）读取

头像路径相对于工作区根目录解析。

## 设置身份

`set-identity` 将字段写入 `agents.list[].identity`：

- `name`
- `theme`
- `emoji`
- `avatar`（工作区相对路径、http(s) URL 或数据 URI）

选项：

- `--agent <id>`
- `--workspace <dir>`
- `--identity-file <path>`
- `--from-identity`
- `--name <name>`
- `--theme <theme>`
- `--emoji <emoji>`
- `--avatar <value>`
- `--json`

注意：

- `--agent` 或 `--workspace` 可用于选择目标代理。
- 如果您依赖 `--workspace` 并且多个代理共享该工作区，命令会失败并要求您传递 `--agent`。
- 当未提供明确的身份字段时，命令从 `IDENTITY.md` 读取身份数据。

从 `IDENTITY.md` 加载：

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

显式覆盖字段：

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

配置示例：

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "OpenClaw",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/openclaw.png",
        },
      },
    ],
  },
}
```
