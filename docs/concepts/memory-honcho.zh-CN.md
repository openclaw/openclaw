---
title: "Honcho记忆"
summary: "通过Honcho插件实现AI原生跨会话记忆"
read_when:
  - 你想要跨会话和频道工作的持久记忆
  - 你想要AI驱动的回忆和用户建模
---

# Honcho记忆

[Honcho](https://honcho.dev) 为OpenClaw添加了AI原生记忆。它将对话持久化到专用服务并随时间构建用户和代理模型，为你的代理提供超越工作区Markdown文件的跨会话上下文。

## 它提供什么

- **跨会话记忆** -- 对话在每个回合后持久化，因此上下文会跨越会话重置、压缩和频道切换。
- **用户建模** -- Honcho为每个用户（偏好、事实、沟通风格）和代理（个性、学习行为）维护一个配置文件。
- **语义搜索** -- 搜索过去对话中的观察，而不仅仅是当前会话。
- **多代理感知** -- 父代理自动跟踪生成的子代理，父代理作为观察者添加到子会话中。

## 可用工具

Honcho注册代理可以在对话中使用的工具：

**数据检索（快速，无LLM调用）：**

| 工具                        | 功能                                 |
| --------------------------- | ------------------------------------ |
| `honcho_context`            | 跨会话的完整用户表示                 |
| `honcho_search_conclusions` | 对存储结论的语义搜索                 |
| `honcho_search_messages`    | 跨会话查找消息（按发送者、日期过滤） |
| `honcho_session`            | 当前会话历史和摘要                   |

**问答（LLM驱动）：**

| 工具         | 功能                                                                  |
| ------------ | --------------------------------------------------------------------- |
| `honcho_ask` | 询问关于用户的问题。`depth='quick'`获取事实，`'thorough'`获取综合信息 |

## 入门

安装插件并运行设置：

```bash
openclaw plugins install @honcho-ai/openclaw-honcho
openclaw honcho setup
openclaw gateway --force
```

设置命令会提示输入你的API凭证，写入配置，并可选地迁移现有的工作区记忆文件。

<Info>
Honcho可以完全在本地运行（自托管）或通过`api.honcho.dev`的托管API运行。自托管选项不需要外部依赖。
</Info>

## 配置

设置位于`plugins.entries["openclaw-honcho"].config`下：

```json5
{
  plugins: {
    entries: {
      "openclaw-honcho": {
        config: {
          apiKey: "your-api-key", // 自托管时省略
          workspaceId: "openclaw", // 记忆隔离
          baseUrl: "https://api.honcho.dev",
        },
      },
    },
  },
}
```

对于自托管实例，将`baseUrl`指向你的本地服务器（例如`http://localhost:8000`）并省略API密钥。

## 迁移现有记忆

如果你有现有的工作区记忆文件（`USER.md`、`MEMORY.md`、`IDENTITY.md`、`memory/`、`canvas/`），`openclaw honcho setup`会检测并提供迁移它们的选项。

<Info>
迁移是非破坏性的 -- 文件会上传到Honcho。原始文件永远不会被删除或移动。
</Info>

## 它如何工作

在每个AI回合后，对话会持久化到Honcho。用户和代理消息都会被观察，允许Honcho随时间构建和完善其模型。

在对话期间，Honcho工具在`before_prompt_build`阶段查询服务，在模型看到提示之前注入相关上下文。这确保了准确的回合边界和相关的回忆。

## Honcho与内置记忆

|              | 内置 / QMD            | Honcho                 |
| ------------ | --------------------- | ---------------------- |
| **存储**     | 工作区Markdown文件    | 专用服务（本地或托管） |
| **跨会话**   | 通过记忆文件          | 自动，内置             |
| **用户建模** | 手动（写入MEMORY.md） | 自动配置文件           |
| **搜索**     | 向量 + 关键词（混合） | 基于观察的语义         |
| **多代理**   | 未跟踪                | 父子感知               |
| **依赖**     | 无（内置）或QMD二进制 | 插件安装               |

Honcho和内置记忆系统可以一起工作。当配置了QMD时，会有额外的工具可用于在Honcho的跨会话记忆旁边搜索本地Markdown文件。

## CLI命令

```bash
openclaw honcho setup                        # 配置API密钥并迁移文件
openclaw honcho status                       # 检查连接状态
openclaw honcho ask <question>               # 向Honcho询问关于用户的问题
openclaw honcho search <query> [-k N] [-d D] # 对记忆进行语义搜索
```

## 进一步阅读

- [插件源代码](https://github.com/plastic-labs/openclaw-honcho)
- [Honcho文档](https://docs.honcho.dev)
- [Honcho OpenClaw集成指南](https://docs.honcho.dev/v3/guides/integrations/openclaw)
- [记忆](/concepts/memory) -- OpenClaw记忆概述
- [上下文引擎](/concepts/context-engine) -- 插件上下文引擎如何工作
