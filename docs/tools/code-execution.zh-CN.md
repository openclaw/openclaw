---
summary: "code_execution -- 使用 xAI 运行沙盒化的远程 Python 分析"
read_when:
  - 你想要启用或配置 code_execution
  - 你想要进行远程分析而不需要本地 shell 访问
  - 你想要将 x_search 或 web_search 与远程 Python 分析结合使用
title: "代码执行"
---

# 代码执行

`code_execution` 在 xAI 的 Responses API 上运行沙盒化的远程 Python 分析。
这与本地的 [`exec`](/tools/exec) 不同：

- `exec` 在你的机器或节点上运行 shell 命令
- `code_execution` 在 xAI 的远程沙盒中运行 Python

使用 `code_execution` 用于：

- 计算
- 制表
- 快速统计
- 图表风格的分析
- 分析由 `x_search` 或 `web_search` 返回的数据

**不要**在需要本地文件、shell、仓库或配对设备时使用它。请使用 [`exec`](/tools/exec) 来完成这些任务。

## 设置

你需要一个 xAI API 密钥。以下任何一种方式都可以：

- `XAI_API_KEY`
- `plugins.entries.xai.config.webSearch.apiKey`

示例：

```json5
{
  plugins: {
    entries: {
      xai: {
        config: {
          webSearch: {
            apiKey: "xai-...",
          },
          codeExecution: {
            enabled: true,
            model: "grok-4-1-fast",
            maxTurns: 2,
            timeoutSeconds: 30,
          },
        },
      },
    },
  },
}
```

## 如何使用

自然地提问并明确分析意图：

```text
使用 code_execution 计算这些数字的 7 天移动平均值：...
```

```text
使用 x_search 查找本周提到 OpenClaw 的帖子，然后使用 code_execution 按天计数。
```

```text
使用 web_search 收集最新的 AI 基准测试数据，然后使用 code_execution 比较百分比变化。
```

该工具内部接受单个 `task` 参数，因此代理应该在一个提示中发送完整的分析请求和任何内联数据。

## 限制

- 这是远程 xAI 执行，不是本地进程执行。
- 应将其视为临时分析，而不是持久化笔记本。
- 不要假设可以访问本地文件或工作区。
- 对于最新的 X 数据，请先使用 [`x_search`](/tools/web#x_search)。

## 另请参阅

- [Web 工具](/tools/web)
- [执行](/tools/exec)
- [xAI](/providers/xai)