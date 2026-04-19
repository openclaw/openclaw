---
summary: "OpenClaw 如何总结长对话以保持在模型限制内"
read_when:
  - 你想了解自动压缩和 /compact
  - 你正在调试达到上下文限制的长会话
---

# 压缩

每个模型都有一个上下文窗口 — 它可以处理的最大令牌数。当对话接近该限制时，OpenClaw 会将较旧的消息**压缩**为摘要，以便聊天可以继续。

## 工作原理

1. 较旧的对话轮次被总结为紧凑条目。
2. 摘要保存在会话记录中。
3. 最近的消息保持完整。

当 OpenClaw 将历史记录拆分为压缩块时，它会将助手工具调用与其匹配的 `toolResult` 条目配对。如果分割点位于工具块内部，OpenClaw 会移动边界，以便配对保持在一起，并且当前未总结的尾部得以保留。

完整的对话历史保存在磁盘上。压缩只会改变模型在下一轮看到的内容。

## 自动压缩

自动压缩默认开启。当会话接近上下文限制时，或者当模型返回上下文溢出错误时（在这种情况下 OpenClaw 会压缩并重试），它会运行。典型的溢出签名包括 `request_too_large`、`context length exceeded`、`input exceeds the maximum number of tokens`、`input token count exceeds the maximum number of input tokens`、`input is too long for the model` 和 `ollama error: context length exceeded`。

<Info>
在压缩之前，OpenClaw 会自动提醒代理将重要笔记保存到 [内存](/concepts/memory) 文件中。这可以防止上下文丢失。
</Info>

使用 `openclaw.json` 中的 `agents.defaults.compaction` 设置来配置压缩行为（模式、目标令牌等）。压缩总结默认保留不透明标识符（`identifierPolicy: "strict"`）。你可以使用 `identifierPolicy: "off"` 覆盖此设置，或使用 `identifierPolicy: "custom"` 和 `identifierInstructions` 提供自定义文本。

你可以通过 `agents.defaults.compaction.model` 为压缩总结指定不同的模型。当你的主模型是本地或小型模型，而你希望压缩总结由更强大的模型生成时，这很有用。覆盖接受任何 `provider/model-id` 字符串：

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "model": "openrouter/anthropic/claude-sonnet-4-6"
      }
    }
  }
}
```

这也适用于本地模型，例如专门用于总结的第二个 Ollama 模型或微调的压缩专家：

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "model": "ollama/llama3.1:8b"
      }
    }
  }
}
```

未设置时，压缩使用代理的主模型。

## 可插拔压缩提供者

插件可以通过插件 API 上的 `registerCompactionProvider()` 注册自定义压缩提供者。当提供者被注册和配置时，OpenClaw 会将总结委托给它，而不是内置的 LLM 管道。

要使用注册的提供者，请在配置中设置提供者 ID：

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "provider": "my-provider"
      }
    }
  }
}
```

设置 `provider` 会自动强制 `mode: "safeguard"`。提供者接收与内置路径相同的压缩指令和标识符保留策略，并且 OpenClaw 在提供者输出后仍然保留最近轮次和分割轮次的后缀上下文。如果提供者失败或返回空结果，OpenClaw 会回退到内置的 LLM 总结。

## 自动压缩（默认开启）

当会话接近或超过模型的上下文窗口时，OpenClaw 会触发自动压缩，并可能使用压缩后的上下文重试原始请求。

你会看到：

- 详细模式下的 `🧹 Auto-compaction complete`
- `/status` 显示 `🧹 Compactions: <count>`

在压缩之前，OpenClaw 可以运行**静默内存刷新**轮次，将持久笔记存储到磁盘。有关详细信息和配置，请参阅 [内存](/concepts/memory)。

## 手动压缩

在任何聊天中输入 `/compact` 以强制压缩。添加指令来指导摘要：

```
/compact Focus on the API design decisions
```

## 使用不同的模型

默认情况下，压缩使用你的代理的主模型。你可以使用更强大的模型获得更好的摘要：

```json5
{
  agents: {
    defaults: {
      compaction: {
        model: "openrouter/anthropic/claude-sonnet-4-6",
      },
    },
  },
}
```

## 压缩开始通知

默认情况下，压缩会静默运行。要在压缩开始时显示简短通知，请启用 `notifyUser`：

```json5
{
  agents: {
    defaults: {
      compaction: {
        notifyUser: true,
      },
    },
  },
}
```

启用后，用户会在每次压缩运行开始时看到一条短消息（例如，"Compacting context..."）。

## 压缩 vs 修剪

|              | 压缩               | 修剪                   |
| ------------ | ------------------ | ---------------------- |
| **作用**     | 总结较旧的对话     | 修剪旧的工具结果       |
| **已保存？** | 是（在会话记录中） | 否（仅内存，每个请求） |
| **范围**     | 整个对话           | 仅工具结果             |

[会话修剪](/concepts/session-pruning) 是一个更轻量级的补充，它修剪工具输出而不进行总结。

## 故障排除

**压缩太频繁？** 模型的上下文窗口可能很小，或者工具输出可能很大。尝试启用 [会话修剪](/concepts/session-pruning)。

**压缩后上下文感觉陈旧？** 使用 `/compact Focus on <topic>` 指导摘要，或启用 [内存刷新](/concepts/memory) 使笔记得以保留。

**需要一个干净的开始？** `/new` 开始一个新会话，不进行压缩。

有关高级配置（保留令牌、标识符保留、自定义上下文引擎、OpenAI 服务器端压缩），请参阅 [会话管理深度解析](/reference/session-management-compaction)。

## 相关

- [会话](/concepts/session) — 会话管理和生命周期
- [会话修剪](/concepts/session-pruning) — 修剪工具结果
- [上下文](/concepts/context) — 如何为代理轮次构建上下文
- [钩子](/automation/hooks) — 压缩生命周期钩子（before_compaction, after_compaction）
