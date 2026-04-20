---
title: "QA 频道"
summary: "用于确定性 OpenClaw QA 场景的合成 Slack 类频道插件"
read_when:
  - 您正在将合成 QA 传输连接到本地或 CI 测试运行中
  - 您需要捆绑的 qa-channel 配置表面
  - 您正在迭代端到端 QA 自动化
---

# QA 频道

`qa-channel` 是一个用于自动化 OpenClaw QA 的捆绑合成消息传输。

它不是生产频道。它的存在是为了在保持状态确定性和完全可检查的同时，使用与真实传输相同的频道插件边界。

## 它现在的功能

- Slack 类目标语法：
  - `dm:<user>`
  - `channel:<room>`
  - `thread:<room>/<thread>`
- 基于 HTTP 的合成总线，用于：
  - 入站消息注入
  - 出站 transcript 捕获
  - 线程创建
  - 反应
  - 编辑
  - 删除
  - 搜索和读取操作
- 捆绑的主机端自检运行器，可编写 Markdown 报告

## 配置

```json
{
  "channels": {
    "qa-channel": {
      "baseUrl": "http://127.0.0.1:43123",
      "botUserId": "openclaw",
      "botDisplayName": "OpenClaw QA",
      "allowFrom": ["*"],
      "pollTimeoutMs": 1000
    }
  }
}
```

支持的账户键：

- `baseUrl`
- `botUserId`
- `botDisplayName`
- `pollTimeoutMs`
- `allowFrom`
- `defaultTo`
- `actions.messages`
- `actions.reactions`
- `actions.search`
- `actions.threads`

## 运行器

当前垂直切片：

```bash
pnpm qa:e2e
```

现在这通过捆绑的 `qa-lab` 扩展路由。它启动仓库内的 QA 总线，启动捆绑的 `qa-channel` 运行时切片，运行确定性自检，并在 `.artifacts/qa-e2e/` 下写入 Markdown 报告。

私有调试器 UI：

```bash
pnpm qa:lab:up
```

这个命令构建 QA 站点，启动 Docker 支持的网关 + QA Lab 堆栈，并打印 QA Lab URL。从该站点，您可以选择场景，选择模型通道，启动单独的运行，并实时观看结果。

完整的仓库支持 QA 套件：

```bash
pnpm openclaw qa suite
```

这会在本地 URL 启动私有 QA 调试器，与随附的 Control UI 包分开。

## 范围

当前范围有意狭窄：

- 总线 + 插件传输
- 线程路由语法
- 频道拥有的消息操作
- Markdown 报告
- 带有运行控件的 Docker 支持 QA 站点

后续工作将添加：

- 提供商/模型矩阵执行
- 更丰富的场景发现
- 稍后的 OpenClaw 原生编排