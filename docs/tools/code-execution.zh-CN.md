---
summary: "code_execution -- 使用 xAI 运行沙盒远程 Python 分析"
read_when:
  - 你想启用或配置 code_execution
  - 你想在没有本地 shell 访问的情况下进行远程分析
  - 你想将 x_search 或 web_search 与远程 Python 分析结合使用
title: "代码执行"
---

# 代码执行

`code_execution` 在 xAI 的 Responses API 上运行沙盒远程 Python 分析。这与本地 [`exec`](/tools/exec) 不同：

- `exec` 在你的机器或节点上运行 shell 命令
- `code_execution` 在 xAI 的远程沙盒中运行 Python

使用 `code_execution` 用于：

- 计算
- 制表
- 快速统计
- 图表式分析
- 分析由 `x_search` 或 `web_search` 返回的数据

当你需要本地文件、shell、仓库或配对设备时，**不要**使用它。为此使用 [`exec`](/tools/exec)。

## 设置

你需要一个 xAI API 密钥。以下任何一个都可以：

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

自然提问并明确分析意图：

```text
Use code_execution to calculate the 7-day moving average for these numbers: ...
```

```text
Use x_search to find posts mentioning OpenClaw this week, then use code_execution to count them by day.
```

```text
Use web_search to gather the latest AI benchmark numbers, then use code_execution to compare percent changes.
```

该工具内部接受单个 `task` 参数，因此代理应在一个提示中发送完整的分析请求和任何内联数据。

## 限制

- 这是远程 xAI 执行，不是本地进程执行。
- 应将其视为临时分析，而不是持久笔记本。
- 不要假设可以访问本地文件或工作区。
- 对于最新的 X 数据，请首先使用 [`x_search`](/tools/web#x_search)。

## 另请参阅

- [网络工具](/tools/web)
- [执行](/tools/exec)
- [xAI](/providers/xai)
