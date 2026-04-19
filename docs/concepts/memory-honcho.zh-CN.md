---
title: "Honcho 内存"
summary: "通过 Honcho 插件实现的 AI 原生跨会话内存"
read_when:
  - 你想要跨会话和频道工作的持久内存
  - 你想要 AI 驱动的回忆和用户建模
---

# Honcho 内存

[Honcho](https://honcho.dev) 为 OpenClaw 添加了 AI 原生内存。它将对话持久化到专用服务，并随时间构建用户和代理模型，为你的代理提供超越工作区 Markdown 文件的跨会话上下文。

## 提供的功能

- **跨会话内存** —— 对话在每一轮后都被持久化，因此上下文可以跨越会话重置、压缩和频道切换。
- **用户建模** —— Honcho 为每个用户（偏好、事实、沟通风格）和代理（个性、学习行为）维护个人资料。
- **语义搜索** —— 搜索过去对话中的观察结果，而不仅仅是当前会话。
- **多代理感知** —— 父代理自动跟踪生成的子代理，父代理作为观察者添加到子会话中。

## 可用工具

Honcho 注册了代理可以在对话中使用的工具：

**数据检索（快速，无 LLM 调用）：**

| 工具                        | 功能                                 |
| --------------------------- | ------------------------------------ |
| `honcho_context`            | 跨会话的完整用户表示                 |
| `honcho_search_conclusions` | 对存储的结论进行语义搜索             |
| `honcho_search_messages`    | 跨会话查找消息（按发送者、日期过滤） |
| `honcho_session`            | 当前会话历史和摘要                   |

**问答（LLM 驱动）：**

| 工具         | 功能                                                                |
| ------------ | ------------------------------------------------------------------- |
| `honcho_ask` | 询问关于用户的问题。`depth='quick'` 用于事实，`'thorough'` 用于综合 |

## 入门

安装插件并运行设置：

```bash
openclaw plugins install @honcho-ai/openclaw-honcho
openclaw honcho setup
openclaw gateway --force
```

设置命令会提示输入 API 凭证，写入配置，并可选地迁移现有的工作区内存文件。

<Info>
Honcho 可以完全在本地运行（自托管）或通过 `api.honcho.dev` 上的托管 API 运行。自托管选项不需要外部依赖。
</Info>

## 配置

设置位于 `plugins.entries["openclaw-honcho"].config` 下：

```json5
{
  plugins: {
    entries: {
      "openclaw-honcho": {
        config: {
          apiKey: "your-api-key", // 自托管时省略
          workspaceId: "openclaw", // 内存隔离
          baseUrl: "https://api.honcho.dev",
        },
      },
    },
  },
}
```

对于自托管实例，将 `baseUrl` 指向你的本地服务器（例如 `http://localhost:8000`）并省略 API 密钥。

## 迁移现有内存

如果你有现有的工作区内存文件（`USER.md`、`MEMORY.md`、`IDENTITY.md`、`memory/`、`canvas/`），`openclaw honcho setup` 会检测并提供迁移它们的选项。

<Info>
迁移是非破坏性的 —— 文件会上传到 Honcho。原始文件永远不会被删除或移动。
</Info>

## 工作原理

在每轮 AI 对话后，对话会被持久化到 Honcho。用户和代理消息都会被观察，允许 Honcho 随时间构建和完善其模型。

在对话期间，Honcho 工具在 `before_prompt_build` 阶段查询服务，在模型看到提示之前注入相关上下文。这确保了准确的回合边界和相关的回忆。

## Honcho 与内置内存对比

|              | 内置 / QMD              | Honcho                 |
| ------------ | ----------------------- | ---------------------- |
| **存储**     | 工作区 Markdown 文件    | 专用服务（本地或托管） |
| **跨会话**   | 通过内存文件            | 自动，内置             |
| **用户建模** | 手动（写入 MEMORY.md）  | 自动个人资料           |
| **搜索**     | 向量 + 关键词（混合）   | 基于观察的语义搜索     |
| **多代理**   | 未跟踪                  | 父子代理感知           |
| **依赖**     | 无（内置）或 QMD 二进制 | 插件安装               |

Honcho 和内置内存系统可以一起工作。当配置了 QMD 时，会有额外的工具可用于搜索本地 Markdown 文件以及 Honcho 的跨会话内存。

## 命令行界面

```bash
openclaw honcho setup                        # 配置 API 密钥并迁移文件
openclaw honcho status                       # 检查连接状态
openclaw honcho ask <question>               # 向 Honcho 查询关于用户的问题
openclaw honcho search <query> [-k N] [-d D] # 在内存中进行语义搜索
```

## 进一步阅读

- [插件源代码](https://github.com/plastic-labs/openclaw-honcho)
- [Honcho 文档](https://docs.honcho.dev)
- [Honcho OpenClaw 集成指南](https://docs.honcho.dev/v3/guides/integrations/openclaw)
- [内存](/concepts/memory) —— OpenClaw 内存概览
- [上下文引擎](/concepts/context-engine) —— 插件上下文引擎如何工作
