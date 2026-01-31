# 自定义 Agent 集成指南

本文档提供将你自己的 Agent 集成到 OpenClaw 的详细实现方案。

## 方案概览

将自定义 Agent 集成到 OpenClaw 有三种主要方式：

1. **作为 Skill**：如果你的 agent 是一个工具/命令，可以作为 skill 添加
2. **作为 Plugin**：如果你的 agent 需要更复杂的集成（工具、hooks、channels）
3. **作为独立 Agent**：如果你的 agent 是一个完整的 AI 系统，可以作为独立的 agent 运行

## 方案 1：作为 Skill 集成

### 适用场景

- Agent 是一个命令行工具或脚本
- Agent 可以通过 shell 命令调用
- Agent 不需要复杂的配置或状态管理

### 实现步骤

#### 1. 创建 Skill 目录

```bash
mkdir -p ~/.openclaw/workspace/skills/my-agent
```

#### 2. 创建 SKILL.md

```markdown
---
name: my_agent
description: "My custom agent that does X"
metadata:
  openclaw:
    emoji: "🤖"
    requires:
      bins: ["my-agent-cli"]  # 你的 agent CLI 工具
---

# My Custom Agent

This skill teaches OpenClaw how to use my custom agent.

## Usage

When the user asks to do X, use the `my-agent-cli` command:

```bash
my-agent-cli --action <action> --input "<user-request>"
```

## Examples

- User: "Do X with Y"
  - Command: `my-agent-cli --action do-x --input "Y"`

- User: "Check status of Z"
  - Command: `my-agent-cli --action status --target "Z"`
```

#### 3. 安装 Agent CLI

确保你的 agent CLI 在 PATH 中：

```bash
# 方式 1：通过包管理器
brew install my-agent-cli

# 方式 2：手动安装
cp my-agent-cli /usr/local/bin/

# 方式 3：在 workspace 中
cp my-agent-cli ~/.openclaw/workspace/skills/my-agent/
```

#### 4. 测试

```bash
openclaw agent --message "use my agent to do X"
```

### 优势

- ✅ 简单快速
- ✅ 无需修改 OpenClaw 代码
- ✅ 可以快速迭代和测试

### 限制

- ❌ 只能通过 shell 调用
- ❌ 无法直接访问 OpenClaw 的内部状态
- ❌ 无法注册自定义 tools

## 方案 2：作为 Plugin 集成

### 适用场景

- Agent 需要注册自定义 tools
- Agent 需要访问 OpenClaw 的内部 API
- Agent 需要响应事件或 hooks
- Agent 需要提供 HTTP 接口

### 实现步骤

#### 1. 创建 Plugin 目录结构

```bash
mkdir -p extensions/my-agent
cd extensions/my-agent
```

#### 2. 创建 package.json

```json
{
  "name": "@openclaw/my-agent",
  "version": "1.0.0",
  "type": "module",
  "description": "My custom agent plugin",
  "openclaw": {
    "extensions": ["./index.ts"]
  },
  "dependencies": {
    "openclaw": "workspace:*"
  }
}
```

#### 3. 创建 openclaw.plugin.json

```json
{
  "id": "my-agent",
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": {
        "type": "string",
        "description": "API key for my agent"
      }
    }
  }
}
```

#### 4. 创建 index.ts

```typescript
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

const plugin = {
  id: "my-agent",
  name: "My Custom Agent",
  description: "My custom agent plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // 注册自定义 tool
    api.registerTool({
      name: "my_agent_tool",
      description: "Call my custom agent",
      parameters: Type.Object({
        action: Type.String({ description: "Action to perform" }),
        input: Type.String({ description: "Input data" }),
      }),
      async execute(_id, params) {
        // 调用你的 agent
        const result = await callMyAgent({
          action: params.action,
          input: params.input,
          apiKey: api.pluginConfig?.apiKey,
        });
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      },
    });

    // 注册 HTTP 路由（可选）
    api.registerHttpRoute({
      path: "/my-agent/webhook",
      handler: async (req, res) => {
        // 处理 webhook
        const data = await req.json();
        await handleWebhook(data);
        res.json({ ok: true });
      },
    });

    // 注册生命周期 hook（可选）
    api.on("agent:message:received", async (event) => {
      // 响应消息接收事件
      if (shouldProcess(event.message)) {
        await processMessage(event.message);
      }
    });
  },
};

export default plugin;

// 你的 agent 调用函数
async function callMyAgent(params: {
  action: string;
  input: string;
  apiKey?: string;
}): Promise<any> {
  // 实现你的 agent 调用逻辑
  // 可以是 HTTP 请求、本地进程调用等
  return { result: "success" };
}

async function handleWebhook(data: any): Promise<void> {
  // 处理 webhook 逻辑
}

async function processMessage(message: any): Promise<void> {
  // 处理消息逻辑
}
```

#### 5. 安装 Plugin

```bash
# 从本地路径安装
openclaw plugins install ./extensions/my-agent

# 或从 npm（如果发布）
openclaw plugins install @openclaw/my-agent
```

#### 6. 配置 Plugin

在 `~/.openclaw/openclaw.json` 中：

```json5
{
  plugins: {
    load: {
      paths: ["./extensions/my-agent"]
    },
    allow: ["my-agent"]
  },
  myAgent: {
    apiKey: "your-api-key"
  },
  tools: {
    allow: ["my_agent_tool"]  // 启用你的 tool
  }
}
```

### 优势

- ✅ 完全访问 OpenClaw API
- ✅ 可以注册自定义 tools
- ✅ 可以响应事件和 hooks
- ✅ 可以提供 HTTP 接口
- ✅ 可以访问配置系统

### 限制

- ❌ 需要 TypeScript 开发
- ❌ 需要理解 OpenClaw 的 plugin API
- ❌ 需要处理版本兼容性

## 方案 3：作为独立 Agent 运行

### 适用场景

- 你的 agent 是一个完整的 AI 系统
- 你希望保持 agent 的独立性
- 你希望通过 OpenClaw 的路由系统集成

### 实现步骤

#### 1. 创建 Agent 配置

在 `~/.openclaw/openclaw.json` 中：

```json5
{
  agents: {
    list: [
      {
        id: "my-custom-agent",
        name: "My Custom Agent",
        workspace: "~/.openclaw/workspace-my-agent",
        agentDir: "~/.openclaw/agents/my-custom-agent/agent",
        model: "anthropic/claude-sonnet-4-5"  // 或使用你的模型
      }
    ]
  },
  bindings: [
    {
      agentId: "my-custom-agent",
      match: {
        channel: "telegram",
        peer: { kind: "dm", id: "user123" }
      }
    }
  ]
}
```

#### 2. 创建 Workspace

```bash
openclaw agents add my-custom-agent
```

或手动创建：

```bash
mkdir -p ~/.openclaw/workspace-my-custom-agent
cd ~/.openclaw/workspace-my-custom-agent
```

#### 3. 配置 Agent 行为

编辑 `AGENTS.md`：

```markdown
# My Custom Agent

This agent specializes in [your domain].

## Capabilities

- Does X
- Handles Y
- Manages Z

## Behavior

When the user asks about X, use the following approach:
1. Analyze the request
2. Call appropriate tools
3. Provide structured response
```

#### 4. 集成你的 Agent 逻辑

##### 方式 A：通过 Skills

在 workspace 中创建 skills，指导 OpenClaw 如何调用你的 agent：

```bash
mkdir -p ~/.openclaw/workspace-my-custom-agent/skills/my-agent-integration
```

创建 `SKILL.md`：

```markdown
---
name: my_agent_integration
description: "Integration with my custom agent system"
---

# My Agent Integration

When the user requests agent-specific functionality, use the following:

1. Call `my-agent-api` with the request
2. Process the response
3. Format for the user
```

##### 方式 B：通过 Plugin Tool

创建一个 plugin，注册 tool 来调用你的 agent API：

```typescript
api.registerTool({
  name: "call_my_agent",
  description: "Call my custom agent API",
  parameters: Type.Object({
    request: Type.String(),
  }),
  async execute(_id, params) {
    const response = await fetch("http://localhost:3000/api/agent", {
      method: "POST",
      body: JSON.stringify({ request: params.request }),
    });
    const result = await response.json();
    return { content: [{ type: "text", text: result.response }] };
  },
});
```

##### 方式 C：通过 Gateway Method

如果你的 agent 需要更深入的集成，可以注册 gateway method：

```typescript
api.registerGatewayMethod("my_agent.process", async (req) => {
  const { message, context } = req.params;
  const result = await processWithMyAgent(message, context);
  return { result };
});
```

#### 5. 配置路由

确保消息路由到你的 agent：

```json5
{
  bindings: [
    {
      agentId: "my-custom-agent",
      match: {
        channel: "telegram",  // 或任何其他 channel
        peer: { kind: "dm", id: "user123" }
      }
    }
  ]
}
```

### 优势

- ✅ 完全独立的 agent 系统
- ✅ 可以利用 OpenClaw 的路由和 channel 支持
- ✅ 可以配置独立的模型和工具权限
- ✅ 可以隔离数据和会话

### 限制

- ❌ 需要管理独立的 workspace 和状态
- ❌ 需要配置路由规则
- ❌ 可能不如直接集成灵活

## 方案对比

| 特性 | Skill | Plugin | 独立 Agent |
|------|-------|--------|------------|
| 实现复杂度 | 低 | 中 | 中-高 |
| 代码修改 | 否 | 是 | 否 |
| API 访问 | 否 | 是 | 部分 |
| 自定义 Tools | 否 | 是 | 通过 Plugin |
| 事件响应 | 否 | 是 | 通过 Plugin |
| HTTP 接口 | 否 | 是 | 通过 Plugin |
| 独立状态 | 否 | 否 | 是 |
| 路由支持 | 否 | 否 | 是 |

## 推荐方案选择

1. **简单工具/命令** → Skill
2. **需要 API 集成** → Plugin
3. **完整 AI 系统** → 独立 Agent + Plugin Tool

## 实际案例

### 案例 1：GitHub Bot Agent

**需求**：创建一个专门处理 GitHub 相关任务的 agent

**方案**：独立 Agent + Skills

```json5
{
  agents: {
    list: [
      {
        id: "github-bot",
        name: "GitHub Bot",
        workspace: "~/.openclaw/workspace-github",
        tools: {
          allow: ["exec", "read", "write"],
          deny: ["browser", "canvas"]
        }
      }
    ]
  },
  bindings: [
    {
      agentId: "github-bot",
      match: {
        channel: "telegram",
        peer: { kind: "group", id: "github-team-group-id" }
      }
    }
  ]
}
```

然后在 workspace 中添加 GitHub skills。

### 案例 2：外部 API Agent

**需求**：集成一个外部 API 服务作为 agent

**方案**：Plugin

```typescript
api.registerTool({
  name: "external_api_call",
  description: "Call external API service",
  parameters: Type.Object({
    endpoint: Type.String(),
    method: Type.String(),
    body: Type.Optional(Type.String()),
  }),
  async execute(_id, params) {
    const response = await fetch(`https://api.example.com/${params.endpoint}`, {
      method: params.method,
      body: params.body,
      headers: {
        "Authorization": `Bearer ${api.pluginConfig?.apiKey}`,
      },
    });
    return { content: [{ type: "text", text: await response.text() }] };
  },
});
```

### 案例 3：本地脚本 Agent

**需求**：通过本地脚本扩展能力

**方案**：Skill

```markdown
---
name: local_script_agent
description: "Use local scripts for processing"
---

# Local Script Agent

When processing requests, use the local script:

```bash
./scripts/process.sh --input "<user-request>"
```
```

## 调试和测试

### 测试 Skill

```bash
# 1. 创建 skill
mkdir -p ~/.openclaw/workspace/skills/test-skill
# 添加 SKILL.md

# 2. 测试
openclaw agent --message "use test skill"

# 3. 检查日志
openclaw gateway --verbose
```

### 测试 Plugin

```bash
# 1. 开发 plugin
cd extensions/my-plugin
pnpm install

# 2. 安装 plugin
openclaw plugins install ./extensions/my-plugin

# 3. 测试 tool
openclaw agent --message "use my_plugin_tool"

# 4. 检查 plugin 状态
openclaw plugins list
```

### 测试独立 Agent

```bash
# 1. 创建 agent
openclaw agents add my-agent

# 2. 测试路由
openclaw message send --channel telegram --to user123 --message "test"

# 3. 检查 agent 状态
openclaw agents list --bindings

# 4. 查看会话
openclaw sessions list --agent my-agent
```

## 总结

选择集成方案取决于你的具体需求：

- **快速集成简单功能** → Skill
- **需要深度集成** → Plugin
- **完整独立系统** → 独立 Agent

无论选择哪种方案，OpenClaw 都提供了灵活的扩展机制来满足你的需求。
