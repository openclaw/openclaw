# OpenClaw 核心机制分析

本文档深入分析 OpenClaw 的三个核心机制：Skills 支持、多 Agent 调用，以及如何创建自定义 Agent。

## 1. Skills 支持机制

### 1.1 Skills 概述

Skills 是 OpenClaw 扩展 AI 助手能力的主要方式。每个 Skill 是一个目录，包含：
- `SKILL.md` 文件：包含 YAML frontmatter 和 Markdown 指令
- 可选的脚本和资源文件

Skills 遵循 [AgentSkills](https://agentskills.io) 兼容格式，用于教 AI 如何使用工具。

### 1.2 Skills 加载机制

#### 加载位置和优先级

Skills 从以下位置加载（优先级从高到低）：

1. **Workspace Skills** (`<workspace>/skills`) - 最高优先级
   - 每个 agent 的独立 workspace 中的 skills
   - 路径：`~/.openclaw/workspace-<agentId>/skills`

2. **Managed/Local Skills** (`~/.openclaw/skills`) - 共享 skills
   - 所有 agent 可见的共享 skills
   - 适用于多 agent 场景

3. **Bundled Skills** (打包在安装中的 skills) - 默认 skills
   - 随 OpenClaw 安装一起提供的 skills
   - 路径由 `resolveBundledSkillsDir()` 解析

4. **Extra Skills** (`skills.load.extraDirs`) - 额外目录
   - 通过配置添加的额外 skill 目录
   - 优先级最低

5. **Plugin Skills** - 插件提供的 skills
   - 插件可以在 `openclaw.plugin.json` 中声明 skills 目录
   - 参与正常的优先级规则

#### 实现代码位置

核心实现位于 `src/agents/skills/workspace.ts`：

```typescript
function loadSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
  },
): SkillEntry[] {
  // 1. 加载各个来源的 skills
  const bundledSkills = loadSkills({ dir: bundledSkillsDir, source: "openclaw-bundled" });
  const managedSkills = loadSkills({ dir: managedSkillsDir, source: "openclaw-managed" });
  const workspaceSkills = loadSkills({ dir: workspaceSkillsDir, source: "openclaw-workspace" });
  
  // 2. 合并并应用优先级
  const merged = new Map<string, Skill>();
  // Precedence: extra < bundled < managed < workspace
  for (const skill of bundledSkills) merged.set(skill.name, skill);
  for (const skill of managedSkills) merged.set(skill.name, skill);
  for (const skill of workspaceSkills) merged.set(skill.name, skill);
  
  // 3. 解析 frontmatter 和元数据
  return skillEntries.map((skill) => ({
    skill,
    frontmatter: parseFrontmatter(raw),
    metadata: resolveOpenClawMetadata(frontmatter),
    invocation: resolveSkillInvocationPolicy(frontmatter),
  }));
}
```

### 1.3 Skill 过滤机制

Skills 在加载时会根据以下条件过滤：

1. **配置过滤** (`skills.allow` / `skills.deny`)
2. **环境要求** (`metadata.openclaw.requires.bins` - 检查二进制是否存在)
3. **配置要求** (`metadata.openclaw.requires.config` - 检查配置项)
4. **技能过滤** (`skillFilter` - 运行时过滤)

实现位置：`src/agents/skills/config.ts` - `shouldIncludeSkill()`

### 1.4 创建自定义 Skill

#### 步骤 1：创建 Skill 目录

```bash
mkdir -p ~/.openclaw/workspace/skills/my-skill
```

或者对于特定 agent：

```bash
mkdir -p ~/.openclaw/workspace-<agentId>/skills/my-skill
```

#### 步骤 2：创建 SKILL.md

```markdown
---
name: my_skill
description: "My custom skill description"
metadata:
  openclaw:
    emoji: "🎯"
    requires:
      bins: ["my-tool"]  # 可选：要求特定二进制存在
      config: ["myConfig.key"]  # 可选：要求配置项存在
    install:
      - id: "brew"
        kind: "brew"
        formula: "my-tool"
        bins: ["my-tool"]
        label: "Install my-tool (brew)"
---

# My Custom Skill

This skill teaches the agent how to use my custom tool.

## Usage

When the user asks to do X, use the `my-tool` command with appropriate parameters.

## Examples

```bash
my-tool --action do-something --target "value"
```
```

#### 步骤 3：添加脚本（可选）

如果需要执行脚本：

```bash
mkdir -p ~/.openclaw/workspace/skills/my-skill/scripts
# 添加可执行脚本
```

#### 步骤 4：刷新 Skills

重启 gateway 或运行：

```bash
openclaw skills refresh
```

### 1.5 Skill 示例

参考现有 skills：
- `skills/github/SKILL.md` - GitHub CLI skill
- `skills/1password/SKILL.md` - 1Password skill
- `skills/coding-agent/SKILL.md` - Coding agent skill

### 1.6 Skills 与 Tools 的关系

- **Skills** 是指导文档，告诉 AI 如何使用工具
- **Tools** 是实际可执行的函数（通过 `api.registerTool()` 注册）
- Skills 可以引用现有的 tools（如 `exec`, `read`, `write`）
- Skills 也可以指导使用外部命令（如 `gh`, `git`）

## 2. 多 Agent 调用机制

### 2.1 Agent 概念

一个 **Agent** 是一个完全隔离的"大脑"，包含：

- **Workspace**：文件、AGENTS.md/SOUL.md/USER.md、本地笔记、persona 规则
- **State Directory** (`agentDir`)：认证配置、模型注册、per-agent 配置
- **Session Store**：聊天历史和路由状态，位于 `~/.openclaw/agents/<agentId>/sessions`

### 2.2 Agent 路由机制

#### 路由规则（优先级从高到低）

实现位置：`src/routing/resolve-route.ts` - `resolveAgentRoute()`

```typescript
export function resolveAgentRoute(input: ResolveAgentRouteInput): ResolvedAgentRoute {
  // 1. Exact peer match (bindings with peer.kind + peer.id)
  // 2. Guild match (Discord) via guildId
  // 3. Team match (Slack) via teamId
  // 4. Account match (accountId on the channel)
  // 5. Channel match (any account on that channel)
  // 6. Default agent (agents.list[].default, else first list entry, fallback to main)
}
```

#### 路由匹配顺序

1. **`peer` 匹配**：精确的 DM/群组/频道 ID
   ```json5
   { agentId: "work", match: { channel: "whatsapp", peer: { kind: "dm", id: "+1234567890" } } }
   ```

2. **`guildId` 匹配**（Discord）
   ```json5
   { agentId: "work", match: { channel: "discord", guildId: "123456789" } }
   ```

3. **`teamId` 匹配**（Slack）
   ```json5
   { agentId: "work", match: { channel: "slack", teamId: "T123456" } }
   ```

4. **`accountId` 匹配**：特定 channel account
   ```json5
   { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } }
   ```

5. **Channel 匹配**：该 channel 的任何 account
   ```json5
   { agentId: "work", match: { channel: "whatsapp" } }
   ```

6. **默认 Agent**：`agents.list[].default` 或第一个列表项，或 `main`

### 2.3 多 Agent 配置示例

#### 示例 1：两个 WhatsApp → 两个 Agent

```json5
{
  agents: {
    list: [
      {
        id: "home",
        default: true,
        name: "Home",
        workspace: "~/.openclaw/workspace-home",
        agentDir: "~/.openclaw/agents/home/agent",
        model: "anthropic/claude-sonnet-4-5"
      },
      {
        id: "work",
        name: "Work",
        workspace: "~/.openclaw/workspace-work",
        agentDir: "~/.openclaw/agents/work/agent",
        model: "anthropic/claude-opus-4-5"
      }
    ]
  },
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } }
  ],
  channels: {
    whatsapp: {
      accounts: {
        personal: {},
        biz: {}
      }
    }
  }
}
```

#### 示例 2：按 Channel 分离

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5"
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-5"
      }
    ]
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } }
  ]
}
```

#### 示例 3：特定 Peer 路由

```json5
{
  agents: {
    list: [
      { id: "chat", name: "Everyday", workspace: "~/.openclaw/workspace-chat" },
      { id: "opus", name: "Deep Work", workspace: "~/.openclaw/workspace-opus" }
    ]
  },
  bindings: [
    // Peer 匹配优先于 channel 匹配
    { agentId: "opus", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551234567" } } },
    { agentId: "chat", match: { channel: "whatsapp" } }
  ]
}
```

### 2.4 Agent 间通信

Agent 可以通过 `sessions_send` tool 相互通信：

```json5
{
  tools: {
    agentToAgent: {
      enabled: true,  // 默认 false
      allow: ["home", "work"]  // 允许的 agent IDs
    }
  }
}
```

### 2.5 Session Key 结构

Session keys 用于隔离不同会话：

- **DM**：`agent:<agentId>:<mainKey>` (默认: `agent:main:main`)
- **Groups**：`agent:<agentId>:<channel>:group:<id>`
- **Channels**：`agent:<agentId>:<channel>:channel:<id>`
- **Threads**：追加 `:thread:<threadId>`

实现位置：`src/routing/session-key.ts`

## 3. 创建自定义 Agent

### 3.1 使用 CLI 创建 Agent

最简单的方式是使用 agent wizard：

```bash
openclaw agents add <agentId>
```

这会：
1. 创建 agent 配置
2. 创建 workspace 目录
3. 创建 agentDir
4. 引导配置 bindings

### 3.2 手动创建 Agent

#### 步骤 1：更新配置

编辑 `~/.openclaw/openclaw.json`：

```json5
{
  agents: {
    list: [
      {
        id: "my-agent",
        name: "My Custom Agent",
        workspace: "~/.openclaw/workspace-my-agent",
        agentDir: "~/.openclaw/agents/my-agent/agent",
        model: "anthropic/claude-sonnet-4-5",  // 可选：per-agent 模型
        identity: {
          name: "My Bot",
          emoji: "🤖"
        },
        tools: {
          allow: ["exec", "read", "write"],  // 可选：限制工具
          deny: ["browser", "canvas"]
        },
        sandbox: {
          mode: "all",  // 可选：沙箱模式
          scope: "agent"
        }
      }
    ]
  },
  bindings: [
    {
      agentId: "my-agent",
      match: {
        channel: "telegram",
        peer: { kind: "dm", id: "user123" }
      }
    }
  ]
}
```

#### 步骤 2：创建 Workspace

```bash
mkdir -p ~/.openclaw/workspace-my-agent
cd ~/.openclaw/workspace-my-agent

# 创建必要的文件
touch AGENTS.md SOUL.md USER.md IDENTITY.md TOOLS.md
```

#### 步骤 3：初始化 Workspace

运行 setup 命令：

```bash
openclaw setup --workspace ~/.openclaw/workspace-my-agent
```

这会创建：
- `AGENTS.md` - Agent 行为定义
- `SOUL.md` - Agent 个性/灵魂
- `USER.md` - 用户信息
- `IDENTITY.md` - Agent 身份
- `TOOLS.md` - 工具使用指南
- `BOOTSTRAP.md` - 引导文件（可选）

#### 步骤 4：创建 Agent Directory

```bash
mkdir -p ~/.openclaw/agents/my-agent/agent
```

这个目录包含：
- `auth-profiles.json` - 认证配置（per-agent）
- 其他 per-agent 状态文件

#### 步骤 5：配置 Bindings

在配置文件中添加 bindings，将消息路由到新 agent。

### 3.3 Agent 配置选项

#### 基本配置

```typescript
{
  id: string;                    // 必需：唯一 agent ID
  name?: string;                 // 显示名称
  default?: boolean;             // 是否为默认 agent
  workspace?: string;            // Workspace 路径
  agentDir?: string;             // Agent 状态目录
  model?: string | ModelConfig;  // Per-agent 模型配置
}
```

#### 高级配置

```typescript
{
  identity?: {
    name?: string;
    emoji?: string;
    theme?: string;
  };
  groupChat?: {
    mentionPatterns?: string[];  // @mention 模式
  };
  sandbox?: {
    mode?: "off" | "non-main" | "all";
    scope?: "agent" | "shared";
  };
  tools?: {
    allow?: string[];
    deny?: string[];
  };
}
```

### 3.4 Per-Agent Skills

每个 agent 可以有独立的 skills：

```bash
# Agent 特定的 skills
~/.openclaw/workspace-my-agent/skills/

# 共享的 skills（所有 agent 可见）
~/.openclaw/skills/
```

### 3.5 Agent 隔离

每个 agent 完全隔离：

- **Workspace**：独立的文件系统
- **Sessions**：独立的会话存储 (`~/.openclaw/agents/<agentId>/sessions`)
- **Auth**：独立的认证配置 (`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`)
- **Skills**：workspace 中的 skills 是独立的
- **Sandbox**：可以配置独立的沙箱环境

### 3.6 实现代码位置

关键实现文件：

- **Agent 路由**：`src/routing/resolve-route.ts`
- **Agent Scope**：`src/agents/agent-scope.ts`
- **Workspace 管理**：`src/agents/workspace.ts`
- **Agent 命令**：`src/commands/agents.commands.add.ts`
- **Session Key**：`src/routing/session-key.ts`

## 4. 最佳实践

### 4.1 Skills 最佳实践

1. **命名规范**：使用小写字母和下划线（如 `my_skill`）
2. **描述清晰**：在 frontmatter 中提供清晰的描述
3. **工具要求**：明确声明所需的二进制和配置
4. **示例丰富**：在 SKILL.md 中提供使用示例
5. **测试**：在 workspace skills 中测试后再提交到 ClawHub

### 4.2 多 Agent 最佳实践

1. **明确路由**：使用最具体的 binding 匹配
2. **隔离数据**：不要共享 `agentDir` 或 `workspace`
3. **命名清晰**：使用有意义的 agent ID 和名称
4. **工具限制**：为不同 agent 配置适当的工具权限
5. **沙箱隔离**：对不信任的 agent 启用沙箱

### 4.3 自定义 Agent 最佳实践

1. **使用 Wizard**：优先使用 `openclaw agents add` 命令
2. **配置文件**：在 `AGENTS.md` 和 `SOUL.md` 中定义 agent 行为
3. **测试隔离**：确保 agent 之间不会相互干扰
4. **备份重要**：定期备份 workspace 和 agentDir
5. **版本控制**：考虑将 workspace 纳入 git 管理

## 5. 参考资源

- [Skills 文档](/tools/skills)
- [创建 Skills](/tools/creating-skills)
- [多 Agent 路由](/concepts/multi-agent)
- [Channel 路由](/concepts/channel-routing)
- [Agent Workspace](/concepts/agent-workspace)
- [Plugins](/plugin)
- [Agent Tools](/plugins/agent-tools)

## 6. 总结

OpenClaw 提供了灵活的扩展机制：

1. **Skills**：通过 Markdown 文档扩展 AI 能力
2. **多 Agent**：通过路由配置实现多个隔离的 AI 助手
3. **自定义 Agent**：通过配置和 workspace 创建专门的 AI 助手

这三个机制相互配合，使得 OpenClaw 可以适应各种使用场景，从个人助手到多用户系统，从简单任务到复杂工作流。
